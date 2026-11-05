import { asc, eq, inArray, or } from "drizzle-orm";
import { isAutomatedMail, parseAddress, replyTokenIn, senderLooksForged, withoutPlus, withoutQuotedReply } from "@/domain/email";
import { BODY_MAX, oneLine, SUBJECT_MAX } from "@/domain/ticket-input";
import { sameSecret } from "@/infrastructure/crypto/secrets";
import { ProviderError } from "@/infrastructure/connectors/http";
import type { Database } from "@/infrastructure/db/client";
import { connection } from "@/infrastructure/db/schema/connections";
import { message, product, ticket } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { clientOf } from "./connections";
import { contactFor } from "./contacts";
import { requesterWrote } from "./conversation";
import { recordDeliveryReport } from "./delivery-reports";
import { notifyTeam, type TeamNotice } from "./notifications";
import type { InboundEmail, InboundRequest } from "./ports";
import type { Services } from "./services";
import { openTicketIn } from "./tickets";

export type HookAnswer = { status: number; body?: string };

/** What the mail said, within what a message may hold: cut plainly rather than dropped when it's too long. */
function bodyOf(text: string, isReply: boolean): string {
  const said = (isReply ? withoutQuotedReply(text) : text).trim();
  if (!said) return "(This mail had no text.)";
  return said.length > BODY_MAX ? `${said.slice(0, BODY_MAX)}\n\n(This mail was cut here: it was longer than a message can hold.)` : said;
}

const mailColumns = (email: InboundEmail) => ({
  providerId: email.providerId,
  emailMessageId: email.messageId,
  emailInReplyTo: email.inReplyTo,
  emailReferences: email.references,
  senderSuspect: senderLooksForged(email.authentication),
  attachments: email.attachments,
});

/**
 * The ticket a mail continues: by the token in the address it was sent to, which survives whatever a
 * mail client does to headers, then by the messages it says it answers, the latest first. Both are
 * read inside the workspace the hook belongs to, so nothing can reach another's tickets.
 */
async function ticketOfMail(tx: Database, email: InboundEmail) {
  const token = replyTokenIn(email.addressedTo);
  if (token) {
    const [byToken] = await tx.select().from(ticket).where(eq(ticket.replyToken, token));
    if (byToken) return byToken;
  }
  const named = [...new Set([email.inReplyTo, ...email.references.toReversed()].filter((id): id is string => Boolean(id)))];
  if (named.length === 0) return null;
  const known = await tx.select({ ticketId: message.ticketId, messageId: message.emailMessageId }).from(message).where(inArray(message.emailMessageId, named));
  const match = named.flatMap((id) => known.filter((row) => row.messageId === id))[0];
  if (!match) return null;
  const [byHeader] = await tx.select().from(ticket).where(eq(ticket.id, match.ticketId));
  return byHeader ?? null;
}

/** The product a new mail is for, by the address it was sent to; with one product there's nothing to work out. */
async function productOfMail(tx: Database, email: InboundEmail): Promise<string | null> {
  const products = await tx.select({ id: product.id, address: product.supportAddress }).from(product);
  const addressed = new Set(email.addressedTo.map(withoutPlus));
  const byAddress = products.find(({ address }) => address && addressed.has(address));
  return byAddress?.id ?? (products.length === 1 ? products[0].id : null);
}

/** A product's address, or the instance's own, whose notifications may come back if a team's address is a support address. */
async function isOwnAddress(tx: Database, from: string, settings: Services["settings"]): Promise<boolean> {
  if (parseAddress(settings.SUCCURO_MAIL_FROM ?? "")?.address === from) return true;
  return (await tx.select({ id: product.id }).from(product).where(eq(product.supportAddress, withoutPlus(from)))).length > 0;
}

async function alreadyRecorded(tx: Database, email: InboundEmail): Promise<boolean> {
  const sameMail = or(eq(message.providerId, email.providerId), email.messageId ? eq(message.emailMessageId, email.messageId) : undefined);
  return (await tx.select({ id: message.id }).from(message).where(sameMail).orderBy(asc(message.id)).limit(1)).length > 0;
}

/** Two copies arriving together both pass the check above; the unique indexes stop the second. */
const isDuplicate = (error: unknown) => {
  const { code, cause } = error as { code?: string; cause?: { code?: string } };
  return code === "23505" || cause?.code === "23505";
};

export type MailOutcome = "continued" | "opened" | "noted" | "duplicate" | "ignored";

/** What a mail came to, and who to tell about it. Only a person writing tells anyone: a machine's mail never does. */
interface Recorded {
  outcome: MailOutcome;
  notice?: TeamNotice;
}

async function recordInTransaction(tx: Database, email: InboundEmail, services: Services): Promise<Recorded> {
  const now = services.now();
  // Nobody to answer: a mail with no address in its From line can't be anyone's request.
  if (!parseAddress(email.from)) return { outcome: "ignored" };
  if (await alreadyRecorded(tx, email)) return { outcome: "duplicate" };
  // Our own mail coming back would answer itself for ever.
  if (await isOwnAddress(tx, email.from, services.settings)) return { outcome: "ignored" };
  const automated = isAutomatedMail(email.headers, email.from);
  const found = await ticketOfMail(tx, email);
  if (!found) {
    if (automated) return { outcome: "ignored" };
    const subject = oneLine(email.subject).slice(0, SUBJECT_MAX) || "(no subject)";
    const productId = await productOfMail(tx, email);
    const body = bodyOf(email.text, false);
    const created = await openTicketIn(tx, { subject, body, requester: { email: email.from, name: email.fromName ?? undefined }, channel: "email", productId, mail: mailColumns(email) }, now);
    return { outcome: "opened", notice: { kind: "new_ticket", ticket: created, writer: { contactId: created.contactId, email: email.from }, words: body } };
  }
  if (automated) {
    // Kept for the team, with no effect on whose turn it is: an out-of-office isn't an answer.
    await tx.insert(message).values({ ...mailColumns(email), ticketId: found.id, kind: "system", body: `An automatic mail arrived from ${email.from}: ${oneLine(email.text).slice(0, 500)}`, fromAddress: email.from });
    return { outcome: "noted" };
  }
  const writer = await contactFor(tx, { email: email.from, name: email.fromName ?? undefined });
  const body = bodyOf(email.text, true);
  await requesterWrote(tx, found, { ...mailColumns(email), body, authorContactId: writer.id, fromAddress: writer.id === found.contactId ? null : email.from }, now);
  return { outcome: "continued", notice: { kind: "requester_answered", ticket: found, writer: { contactId: writer.id, email: email.from }, words: body } };
}

/** Records a mail someone sent to a support address. Whatever it says, it stays data: it can start or continue a ticket and nothing more. */
export async function recordInboundMail(services: Services, workspaceId: string, email: InboundEmail): Promise<MailOutcome> {
  try {
    const { outcome, notice } = await withWorkspace(services.db, workspaceId, (tx) => recordInTransaction(tx, email, services));
    if (notice) await notifyTeam(services, workspaceId, notice);
    return outcome;
  } catch (error) {
    if (isDuplicate(error)) return "duplicate";
    throw error;
  }
}

/**
 * Where a connected service posts what happened. The address's token comes first, then the adapter
 * checks the service's own signature. Any answer but a 2xx makes the service send it again, which is
 * what a failure to fetch a mail's body wants.
 */
export async function receiveHook(services: Services, connectionId: string, token: string | null, request: InboundRequest): Promise<HookAnswer> {
  const [row] = await services.db.select().from(connection).where(eq(connection.id, connectionId));
  if (!row || !token || !sameSecret(token, row.hookToken)) return { status: 404 };
  try {
    const { client } = clientOf(services, row);
    if (!client.readWebhook) return { status: 404 };
    const event = await client.readWebhook(request);
    if (event.type === "received") return { status: 200, body: await recordInboundMail(services, row.workspaceId, event.email) };
    if (event.type === "delivery") return { status: 200, body: await recordDeliveryReport(services, row.workspaceId, event.report) };
    return { status: 200, body: "ignored" };
  } catch (error) {
    return { status: error instanceof ProviderError ? error.status : 500, body: error instanceof ProviderError ? error.message : "This couldn’t be read." };
  }
}
