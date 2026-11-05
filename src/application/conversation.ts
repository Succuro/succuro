import { eq } from "drizzle-orm";
import { bodyInput, firstProblem } from "@/domain/ticket-input";
import { isSettled, STATUS_AFTER_REQUESTER_WROTE } from "@/domain/tickets";
import type { Database } from "@/infrastructure/db/client";
import { message, ticket } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Services } from "./services";
import type { Actor } from "./tickets";

/** An internal note: for the team, never sent, never shown to a requester. */
export async function addNote(services: Pick<Services, "db">, workspaceId: string, number: number, text: string, actor: Actor): Promise<{ ok: true; noteId: string } | { ok: false; error: string }> {
  const body = bodyInput.safeParse(text);
  if (!body.success) return { ok: false, error: firstProblem(body.error) };
  return withWorkspace(services.db, workspaceId, async (tx) => {
    const [row] = await tx.select({ id: ticket.id }).from(ticket).where(eq(ticket.number, number));
    if (!row) return { ok: false, error: `There’s no ticket #${number} in this workspace.` };
    const [note] = await tx.insert(message).values({ ticketId: row.id, kind: "note", body: body.data, authorUserId: actor.userId, writtenBy: actor.writtenBy }).returning({ id: message.id });
    return { ok: true, noteId: note.id };
  });
}

type TicketRow = typeof ticket.$inferSelect;

/** What's new when a requester writes: the message, and the ticket back with support, reopened if it had settled. */
export async function requesterWrote(tx: Database, row: Pick<TicketRow, "id" | "status">, written: Pick<typeof message.$inferInsert, "body" | "authorContactId" | "providerId" | "emailMessageId" | "emailInReplyTo" | "emailReferences" | "fromAddress" | "senderSuspect" | "attachments">, now: Date): Promise<void> {
  await tx.insert(message).values({ ...written, ticketId: row.id, kind: "customer" });
  await tx.update(ticket).set({ status: STATUS_AFTER_REQUESTER_WROTE, lastMessageAt: now, resolvedAt: null }).where(eq(ticket.id, row.id));
  if (isSettled(row.status)) await tx.insert(message).values({ ticketId: row.id, kind: "system", body: "Reopened: the requester wrote again." });
}
