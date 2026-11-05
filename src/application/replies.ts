import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { replyAddress, replySubject, senderHeader, threadOf } from "@/domain/email";
import { bodyInput, firstProblem } from "@/domain/ticket-input";
import { resolvedAtAfter, statusAfterReply, type TicketStatus } from "@/domain/tickets";
import type { Tried } from "@/domain/tried";
import { sha256 } from "@/infrastructure/crypto/secrets";
import { ProviderError } from "@/infrastructure/connectors/http";
import type { Database } from "@/infrastructure/db/client";
import { contact, message, product, ticket } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { scheduledWorkChanged } from "@/infrastructure/scheduling/scheduled-work";
import { connectionWith, markFailing } from "./connections";
import { requesterUrlOf } from "./requester-links";
import type { Services } from "./services";
import type { Actor } from "./tickets";
import { settingsOf } from "./workspace-settings";

/**
 * Replies to people who wrote in. A reply is a message of kind "agent" with a delivery state, which
 * is how a draft waits for a member and how a failure stays visible. This tool never writes first:
 * every mail here answers a ticket someone opened, so it stays support mail and never becomes cold mail.
 */

const NO_TICKET = (number: number) => `There’s no ticket #${number} in this workspace.`;

export type Drafted = { ok: true; draftId: string } | { ok: false; error: string };

async function insertDraft(db: Database, workspaceId: string, number: number, text: string, actor: Actor): Promise<Drafted> {
  const body = bodyInput.safeParse(text);
  if (!body.success) return { ok: false, error: firstProblem(body.error) };
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx.select({ id: ticket.id }).from(ticket).where(eq(ticket.number, number));
    if (!row) return { ok: false, error: NO_TICKET(number) };
    const [draft] = await tx.insert(message).values({ ticketId: row.id, kind: "agent", body: body.data, authorUserId: actor.userId, writtenBy: actor.writtenBy, deliveryState: "draft" }).returning({ id: message.id });
    return { ok: true, draftId: draft.id };
  });
}

/** Saves a reply for a member to send: what an assistant does by default, and what a member does when they aren't ready. Nothing leaves. */
export const saveDraft = insertDraft;

export async function discardDraft(db: Database, workspaceId: string, draftId: string): Promise<boolean> {
  const deleted = await withWorkspace(db, workspaceId, (tx) => tx.delete(message).where(and(eq(message.id, draftId), eq(message.kind, "agent"), eq(message.deliveryState, "draft"))).returning({ id: message.id }));
  return deleted.length > 0;
}

/** Takes a draft or a failed reply for sending; a second press finds nothing to take, so one reply can't leave twice at once. */
async function claimForSending(tx: Database, messageId: string, actor: Actor, body?: string) {
  // Words a member changed are theirs; sent as they stood, an assistant's draft still says who wrote it.
  const edited = body === undefined ? {} : { body, writtenBy: sql`case when ${message.body} = ${body} then ${message.writtenBy} else ${actor.writtenBy}::message_writer end` };
  const [claimed] = await tx
    .update(message)
    .set({ deliveryState: "sending", deliveryError: null, authorUserId: actor.userId, ...edited })
    .where(and(eq(message.id, messageId), eq(message.kind, "agent"), inArray(message.deliveryState, ["draft", "failed"])))
    .returning();
  return claimed;
}

/** Everything a reply's mail needs: who it's to, what it's from, and the thread it continues. */
async function mailContext(tx: Database, ticketId: string) {
  const [row] = await tx
    .select({ ticket, to: contact.email, address: product.supportAddress, senderName: product.senderName, productName: product.name })
    .from(ticket)
    .innerJoin(contact, eq(contact.id, ticket.contactId))
    .leftJoin(product, eq(product.id, ticket.productId))
    .where(eq(ticket.id, ticketId));
  const earlier = await tx
    .select({ id: message.emailMessageId })
    .from(message)
    .where(and(eq(message.ticketId, ticketId), isNotNull(message.emailMessageId)))
    .orderBy(asc(message.createdAt));
  return { ...row, thread: threadOf(earlier.map(({ id }) => id)) };
}

type MailContext = Awaited<ReturnType<typeof mailContext>>;

/** The requester's page goes in every mail: their mailbox may lose the thread, and this way in doesn't depend on it. */
function textWithLink(body: string, context: MailContext, url: string): string {
  const signature = context.senderName ?? context.productName;
  return [body, "", "--", ...(signature ? [signature] : []), `Ticket #${context.ticket.number}. Read or answer this conversation: ${url}`, ""].join("\n");
}

const whyNotSent = (error: unknown) => (error instanceof Error ? error.message : "The service didn’t answer.");

async function recordFailure(services: Services, workspaceId: string, messageId: string, why: string): Promise<Tried> {
  await withWorkspace(services.db, workspaceId, (tx) => tx.update(message).set({ deliveryState: "failed", deliveryError: why }).where(eq(message.id, messageId)));
  return { ok: false, error: why };
}

/** What a reply that left changes: the first response, the conversation's last activity, and whose turn it is. */
async function recordSent(services: Services, workspaceId: string, sent: { messageId: string; providerId: string; ticket: MailContext["ticket"]; thread: MailContext["thread"]; status?: TicketStatus }): Promise<void> {
  const now = services.now();
  const status = statusAfterReply(sent.status);
  await withWorkspace(services.db, workspaceId, async (tx) => {
    await tx.update(message).set({ deliveryState: "sent", providerId: sent.providerId, emailInReplyTo: sent.thread.inReplyTo ?? null, emailReferences: sent.thread.references }).where(eq(message.id, sent.messageId));
    await tx
      .update(ticket)
      .set({ status, firstResponseAt: sent.ticket.firstResponseAt ?? now, lastMessageAt: now, resolvedAt: resolvedAtAfter(status, sent.ticket.resolvedAt, now) })
      .where(eq(ticket.id, sent.ticket.id));
  });
}

/** Sends a draft or a failed reply, and says plainly what came of it. Whatever goes wrong stays on the message, for the screen to show. */
export async function sendReply(services: Services, workspaceId: string, messageId: string, actor: Actor, options: { body?: string; status?: TicketStatus } = {}): Promise<Tried> {
  const { body } = options;
  const parsed = body === undefined ? null : bodyInput.safeParse(body);
  if (parsed && !parsed.success) return { ok: false, error: firstProblem(parsed.error) };
  const claimed = await withWorkspace(services.db, workspaceId, async (tx) => {
    const reply = await claimForSending(tx, messageId, actor, parsed?.data);
    return reply && { reply, context: await mailContext(tx, reply.ticketId) };
  });
  if (!claimed) return { ok: false, error: "This reply isn’t waiting to be sent: it may have left already." };
  // Before anything can go wrong: the scheduled job must know a reply is in flight, whatever happens to this request.
  scheduledWorkChanged();
  const { reply, context } = claimed;
  if (!context.address) return recordFailure(services, workspaceId, messageId, context.productName ? `${context.productName} has no support address yet: set one in its settings, then send this again.` : "This ticket has no product, so it has no address to answer from: choose its product, then send this again.");
  const opened = await connectionWith(services, workspaceId, "send_email");
  if (!opened?.client.sendEmail) return recordFailure(services, workspaceId, messageId, "No mail service is connected: connect one, then send this again.");
  // Issued from the reply's own moment: sent again, its mail is the same to the byte.
  const text = textWithLink(reply.body, context, requesterUrlOf(services, context.ticket, reply.createdAt));
  const mail = { from: senderHeader(context.senderName ?? context.productName, context.address), replyTo: replyAddress(context.address, context.ticket.replyToken), to: context.to, subject: replySubject(context.ticket.subject), text, inReplyTo: context.thread.inReplyTo, references: context.thread.references };
  try {
    // Sent again after dying halfway, the same mail leaves once, if the first try reached the service after all. Changed words are a new mail, and so is a try after the service reported the last one failed: it has a provider id by then.
    const { providerId } = await opened.client.sendEmail({ ...mail, idempotencyKey: sha256(JSON.stringify([messageId, mail, reply.providerId])) });
    await recordSent(services, workspaceId, { messageId, providerId, ticket: context.ticket, thread: context.thread, status: options.status });
    return { ok: true, said: `Sent to ${context.to}.` };
  } catch (error) {
    const refused = error instanceof ProviderError && (error.status === 401 || error.status === 403);
    if (refused) await markFailing(services, workspaceId, opened.row.id, whyNotSent(error));
    return recordFailure(services, workspaceId, messageId, whyNotSent(error));
  }
}

/** A member's reply, written and sent in one go: it is recorded first, so a failure keeps the words. */
export async function replyNow(services: Services, workspaceId: string, number: number, body: string, actor: Actor, status?: TicketStatus): Promise<Tried> {
  const drafted = await insertDraft(services.db, workspaceId, number, body, actor);
  return drafted.ok ? sendReply(services, workspaceId, drafted.draftId, actor, { status }) : drafted;
}

export const APPROVE_FIRST = "This workspace is approve-first: replies from an assistant wait for a member. The draft is saved on the ticket, for a member to send from the screen. Only an owner or admin can change this, on the settings screen: no tool can.";

/**
 * An assistant sending a draft. Refused unless the workspace's setting allows it, read here on every
 * call: nothing an assistant passes can stand in for it. Its member saying yes is the assistant's to
 * respect (the tool's description asks, and the call must declare it), since only it sees the conversation.
 */
export async function sendReplyAsAssistant(services: Services, workspaceId: string, userId: string, draftId: string): Promise<Tried> {
  const { assistantMaySend } = await settingsOf(services.db, workspaceId);
  if (!assistantMaySend) return { ok: false, error: APPROVE_FIRST };
  return sendReply(services, workspaceId, draftId, { userId, writtenBy: "assistant" });
}
