import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { parseAddress } from "@/domain/email";
import type { Tried } from "@/domain/tried";
import type { Database } from "@/infrastructure/db/client";
import { message, product, screenedMail, type ticket } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { notifyTeam } from "./notifications";
import type { Services } from "./services";
import { teamOf } from "./team";
import { openTicketIn } from "./tickets";

/**
 * Mail that didn't open a ticket, and what a member decides about it. Screening itself is done by
 * the inbound use case; nothing here ever writes to whoever sent it.
 */

const PAGE_SIZE = 50;

export type ScreenedTab = "waiting" | "dismissed";

const isId = (value: string) => z.uuid().safeParse(value).success;

export type ScreenedMail = typeof screenedMail.$inferSelect;

/** One tab of the list, latest first, and how many each tab holds. Mail that became a ticket has left the list. */
export function screenedMailOf(db: Database, workspaceId: string, tab: ScreenedTab, page = 1) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(screenedMail)
      .where(eq(screenedMail.state, tab))
      .orderBy(desc(screenedMail.receivedAt), desc(screenedMail.id))
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE);
    const counted = await tx.select({ state: screenedMail.state, count: sql<number>`count(*)::integer` }).from(screenedMail).groupBy(screenedMail.state);
    const countOf = (state: ScreenedTab) => counted.find((row) => row.state === state)?.count ?? 0;
    return { mails: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE, counts: { waiting: countOf("waiting"), dismissed: countOf("dismissed") } };
  });
}

/** How many wait for a decision: nobody is told about them, so the inbox says. */
export async function screenedWaitingCount(db: Database, workspaceId: string): Promise<number> {
  const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select({ count: sql<number>`count(*)::integer` }).from(screenedMail).where(eq(screenedMail.state, "waiting")));
  return row.count;
}

type Opened = { ok: true; ticket: typeof ticket.$inferSelect; requester: string; words: string } | { ok: false; error: string };

/** The ticket a screened mail becomes, dated when the mail arrived, with its mail ids so an answer to it finds the ticket. */
async function openFromScreened(tx: Database, id: string, productId: string | null, actor: { userId: string; name: string }, now: Date): Promise<Opened> {
  const [mail] = await tx.select().from(screenedMail).where(eq(screenedMail.id, id)).for("update");
  if (!mail) return { ok: false, error: "This mail is no longer here." };
  if (mail.state === "promoted") return { ok: false, error: "This mail already became a ticket." };
  const requester = parseAddress(mail.fromAddress);
  if (!requester) return { ok: false, error: "This mail has no sender address, so nobody could be answered: dismiss it instead." };
  // A foreign key checks a row exists, not whose it is: this asks as the workspace.
  if (productId && (await tx.select({ id: product.id }).from(product).where(eq(product.id, productId))).length === 0) return { ok: false, error: "There’s no such product in this workspace." };
  const mailDetails = { providerId: mail.providerId, emailMessageId: mail.emailMessageId, emailInReplyTo: mail.emailInReplyTo, emailReferences: mail.emailReferences, senderSuspect: mail.senderSuspect, attachments: mail.attachments };
  const created = await openTicketIn(tx, { subject: mail.subject, body: mail.body, requester: { email: requester.address, name: mail.fromName ?? undefined }, channel: "email", productId, mail: mailDetails, receivedAt: mail.receivedAt }, now);
  await tx.insert(message).values({ ticketId: created.id, kind: "system", body: `${actor.name} opened this from Screened.`, authorUserId: actor.userId, writtenBy: "member" });
  await tx.update(screenedMail).set({ state: "promoted", ticketId: created.id, decidedBy: actor.userId, decidedAt: now }).where(eq(screenedMail.id, id));
  return { ok: true, ticket: created, requester: requester.address, words: mail.body };
}

export type Promoted = { ok: true; number: number } | { ok: false; error: string };

/** Turns a screened mail into a ticket, for the product the member chose. The team hears of it like any new ticket; the sender hears nothing. */
export async function promoteScreenedMail(services: Services, workspaceId: string, userId: string, id: string, productId: string | null): Promise<Promoted> {
  if (!isId(id) || (productId && !isId(productId))) return { ok: false, error: "This mail is no longer here." };
  const name = (await teamOf(services.db, workspaceId)).find((person) => person.userId === userId)?.name ?? "A member";
  const opened = await withWorkspace(services.db, workspaceId, (tx) => openFromScreened(tx, id, productId, { userId, name }, services.now()));
  if (!opened.ok) return opened;
  await notifyTeam(services, workspaceId, { kind: "new_ticket", ticket: opened.ticket, writer: { contactId: opened.ticket.contactId, email: opened.requester, userId }, words: opened.words });
  return { ok: true, number: opened.ticket.number };
}

/** Sets mail aside. It stays in the Dismissed tab, where it can still become a ticket, and the same mail posted again stays known. */
export async function dismissScreenedMails(services: Pick<Services, "db" | "now">, workspaceId: string, userId: string, ids: readonly string[]): Promise<Tried> {
  const wanted = ids.filter(isId);
  if (wanted.length === 0) return { ok: false, error: "Select some mail first." };
  const changed = await withWorkspace(services.db, workspaceId, (tx) =>
    tx
      .update(screenedMail)
      .set({ state: "dismissed", decidedBy: userId, decidedAt: services.now() })
      .where(and(inArray(screenedMail.id, wanted), eq(screenedMail.state, "waiting")))
      .returning({ id: screenedMail.id }),
  );
  return { ok: true, said: changed.length === 1 ? "1 mail dismissed." : `${changed.length} mails dismissed.` };
}
