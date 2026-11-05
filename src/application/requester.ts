import { and, asc, eq, inArray } from "drizzle-orm";
import { bodyInput, firstProblem } from "@/domain/ticket-input";
import type { TicketStatus } from "@/domain/tickets";
import type { Tried } from "@/domain/tried";
import { readRequesterToken, type RequesterClaims } from "@/infrastructure/crypto/requester-token";
import type { Database } from "@/infrastructure/db/client";
import { contact, message, product, ticket, type NotedAttachment } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { requesterWrote } from "./conversation";
import { notifyTeam } from "./notifications";
import { HOUR_LIMITS, takesOneMore } from "./rate-limit";
import type { Services } from "./services";

/**
 * Everything a requester's link can reach, kept in one place. It reads through a list of what they
 * may see, never around one: notes, system lines and drafts stay out, and so does anything a future
 * kind or state might hold, until someone decides otherwise.
 */

type MessageRow = Pick<typeof message.$inferSelect, "kind" | "deliveryState" | "authorContactId">;

/** Replies that left. A failed one may be reworded and sent again, so it isn't theirs yet. */
const LEFT = ["sent", "delivered", "delayed", "bounced", "complained"] as const;

/** What a requester may see: their own words, and replies that were actually sent. Someone else writing on their ticket by mail isn't shown as if it were part of the conversation. */
export function requesterMaySee({ kind, deliveryState, authorContactId }: MessageRow, contactId: string): boolean {
  if (kind === "customer") return authorContactId === contactId;
  return kind === "agent" && (LEFT as readonly (string | null)[]).includes(deliveryState);
}

export interface RequesterMessage {
  id: string;
  from: "you" | "support";
  body: string;
  at: Date;
  attachments: NotedAttachment[];
}

export interface RequesterTicket {
  number: number;
  subject: string;
  status: TicketStatus;
  /** Who they're writing to. */
  productName: string | null;
  productColour: string | null;
  messages: RequesterMessage[];
}

export type RequesterSeen = { status: "open"; ticket: RequesterTicket } | { status: "invalid" | "expired" };

/** A token's claims when it is good now. Refused without the database when it can't be: a forged link wakes nothing. */
const claimsOf = (services: Pick<Services, "settings" | "now">, token: string) => readRequesterToken(token, services.settings.BETTER_AUTH_SECRET, services.now());

/** The ticket a token names, if its links are still good. Run as the token's workspace, so it reaches nothing else. */
async function linkedTicket(tx: Database, claims: RequesterClaims) {
  const [row] = await tx
    .select({ id: ticket.id, number: ticket.number, subject: ticket.subject, status: ticket.status, contactId: ticket.contactId, contactEmail: contact.email, assigneeId: ticket.assigneeId, productId: ticket.productId, productName: product.name, productColour: product.colour })
    .from(ticket)
    .innerJoin(contact, eq(contact.id, ticket.contactId))
    .leftJoin(product, eq(product.id, ticket.productId))
    .where(and(eq(ticket.id, claims.ticketId), eq(ticket.linkVersion, claims.version)));
  return row;
}

/** What a requester's page shows. */
export async function seeAsRequester(services: Services, token: string): Promise<RequesterSeen> {
  const read = claimsOf(services, token);
  if (!read.valid) return { status: read.why };
  return withWorkspace(services.db, read.claims.workspaceId, async (tx) => {
    const row = await linkedTicket(tx, read.claims);
    if (!row) return { status: "invalid" };
    const rows = await tx
      .select({ id: message.id, kind: message.kind, body: message.body, at: message.createdAt, deliveryState: message.deliveryState, authorContactId: message.authorContactId, attachments: message.attachments })
      .from(message)
      .where(and(eq(message.ticketId, row.id), inArray(message.kind, ["customer", "agent"])))
      .orderBy(asc(message.createdAt), asc(message.id));
    const messages = rows.filter((entry) => requesterMaySee(entry, row.contactId)).map(({ id, kind, body, at, attachments }): RequesterMessage => ({ id, from: kind === "customer" ? "you" : "support", body, at, attachments }));
    return { status: "open", ticket: { number: row.number, subject: row.subject, status: row.status, productName: row.productName, productColour: row.productColour, messages } };
  });
}

/** A requester answering from their page: written as them, on this ticket only, and it reopens it. */
export async function answerAsRequester(services: Services, token: string, text: string): Promise<Tried> {
  const read = claimsOf(services, token);
  if (!read.valid) return { ok: false, error: read.why === "expired" ? "This link has expired: answer the last email you received, and the next one will carry a new link." : "This link isn’t valid." };
  const body = bodyInput.safeParse(text);
  if (!body.success) return { ok: false, error: firstProblem(body.error) };
  const { workspaceId } = read.claims;
  const answered = await withWorkspace(services.db, workspaceId, async (tx) => {
    const row = await linkedTicket(tx, read.claims);
    if (!row) return { refused: "This link isn’t valid." };
    if (!(await takesOneMore(tx, `requester:${row.id}`, HOUR_LIMITS.requesterAnswers, services.now()))) return { refused: "That’s a lot of messages in one hour: please try again later." };
    await requesterWrote(tx, row, { body: body.data, authorContactId: row.contactId }, services.now());
    return { row };
  });
  if (!answered.row) return { ok: false, error: answered.refused as string };
  const { row } = answered;
  await notifyTeam(services, workspaceId, { kind: "requester_answered", ticket: row, writer: { contactId: row.contactId, email: row.contactEmail }, words: body.data });
  return { ok: true, said: "Your answer was added to the conversation." };
}
