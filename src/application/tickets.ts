import { randomBytes } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { REPLY_TOKEN_BYTES, replyTokenFrom } from "@/domain/email";
import { cleanTags, type About, type NewTicketInput, type Requester } from "@/domain/ticket-input";
import { FIRST_TICKET_NUMBER, PRIORITY_NAMES, resolvedAtAfter, STATUS_NAMES, type TicketChannel, type TicketPriority, type TicketStatus } from "@/domain/tickets";
import type { Database } from "@/infrastructure/db/client";
import { category, message, product, ticket, ticketCounter } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { contactFor } from "./contacts";
import { notifyTeam } from "./notifications";
import { requesterUrlOf } from "./requester-links";
import type { Services } from "./services";
import { teamOf } from "./team";

/** The next number in the workspace: the upsert locks its row until the transaction ends, so numbers aren't shared or skipped by a failure. */
async function nextNumber(tx: Database): Promise<number> {
  const [row] = await tx
    .insert(ticketCounter)
    .values({ last: FIRST_TICKET_NUMBER })
    .onConflictDoUpdate({ target: ticketCounter.workspaceId, set: { last: sql`${ticketCounter.last} + 1` } })
    .returning({ last: ticketCounter.last });
  return row.last;
}

/** What a mail adds to the first message of the ticket it opens. */
export type FirstMailDetails = Pick<typeof message.$inferInsert, "providerId" | "emailMessageId" | "emailInReplyTo" | "emailReferences" | "senderSuspect" | "attachments">;

export interface TicketToOpen {
  subject: string;
  body: string;
  requester: Requester;
  channel: TicketChannel;
  productId?: string | null;
  categoryId?: string | null;
  priority?: TicketPriority;
  tags?: string[];
  about?: About;
  context?: Record<string, unknown>;
  /** Who recorded it on the requester's behalf, when they didn't write it themselves. */
  recordedBy?: { userId: string; writtenBy: "member" | "assistant" };
  mail?: FirstMailDetails;
}

/** Opens a ticket with its first message, in the caller's workspace transaction. */
export async function openTicketIn(tx: Database, input: TicketToOpen, now: Date) {
  const requester = await contactFor(tx, input.requester);
  const [created] = await tx
    .insert(ticket)
    .values({
      number: await nextNumber(tx),
      subject: input.subject,
      productId: input.productId ?? null,
      categoryId: input.categoryId ?? null,
      contactId: requester.id,
      priority: input.priority ?? "normal",
      tags: input.tags ?? [],
      channel: input.channel,
      aboutType: input.about?.type ?? null,
      aboutId: input.about?.id ?? null,
      aboutTitle: input.about?.title ?? null,
      aboutUrl: input.about?.url ?? null,
      context: input.context ?? null,
      replyToken: replyTokenFrom(randomBytes(REPLY_TOKEN_BYTES)),
      lastMessageAt: now,
    })
    .returning();
  await tx.insert(message).values({ ...input.mail, ticketId: created.id, kind: "customer", body: input.body, authorContactId: requester.id, authorUserId: input.recordedBy?.userId ?? null, writtenBy: input.recordedBy?.writtenBy ?? null });
  return created;
}

export type TicketCreated = { ok: true; id: string; number: number; status: TicketStatus; requesterUrl: string } | { ok: false; error: string };

interface Origin {
  channel: TicketChannel;
  recordedBy?: TicketToOpen["recordedBy"];
}

/** A product and a category are named by whoever opens the ticket, so they're looked up in this workspace only and a wrong name is said. */
async function resolveNames(tx: Database, input: Pick<NewTicketInput, "product" | "category">): Promise<{ productId?: string; categoryId?: string; error?: string }> {
  const [productRow] = input.product ? await tx.select({ id: product.id }).from(product).where(eq(product.slug, input.product)) : [];
  if (input.product && !productRow) return { error: `There’s no product "${input.product}" in this workspace.` };
  const [categoryRow] = input.category ? await tx.select({ id: category.id }).from(category).where(eq(category.name, input.category)) : [];
  if (input.category && !categoryRow) return { error: `There’s no category "${input.category}" in this workspace.` };
  return { productId: productRow?.id, categoryId: categoryRow?.id };
}

/** A ticket from an app, an assistant or the screen: the same use case behind all three. */
export async function createTicket(services: Services, workspaceId: string, input: NewTicketInput, origin: Origin): Promise<TicketCreated> {
  const { subject, message: body, requester, priority, tags, about, context } = input;
  const opened = await withWorkspace(services.db, workspaceId, async (tx) => {
    const named = await resolveNames(tx, input);
    if (named.error) return { error: named.error };
    return { created: await openTicketIn(tx, { subject, body, requester, priority, tags, about, context, productId: named.productId, categoryId: named.categoryId, ...origin }, services.now()) };
  });
  if (!opened.created) return { ok: false, error: opened.error as string };
  const { created } = opened;
  await notifyTeam(services, workspaceId, { kind: "new_ticket", ticket: created, writer: { contactId: created.contactId, email: requester.email, userId: origin.recordedBy?.userId }, words: body });
  return { ok: true, id: created.id, number: created.number, status: created.status, requesterUrl: requesterUrlOf(services, created) };
}

export interface TicketChanges {
  status?: TicketStatus;
  priority?: TicketPriority;
  /** Null takes it off whoever had it. */
  assigneeId?: string | null;
  categoryId?: string | null;
  /** The product it's about, which decides the address replies leave from. */
  productId?: string | null;
  /** Replaces the tags. */
  tags?: string[];
  /** Adds to them. */
  addTags?: string[];
  removeTags?: string[];
}

export interface Actor {
  userId: string;
  writtenBy: "member" | "assistant";
}

type TicketRow = typeof ticket.$inferSelect;

const nextTags = (row: TicketRow, changes: TicketChanges) => {
  if (changes.tags) return cleanTags(changes.tags);
  const removed = new Set(cleanTags(changes.removeTags ?? []));
  return cleanTags([...row.tags, ...(changes.addTags ?? [])]).filter((tag) => !removed.has(tag));
};

/** The lines a conversation keeps about what changed, for the team: a requester never sees them. */
function changeLines(row: TicketRow, after: Pick<TicketRow, "status" | "priority" | "assigneeId">, who: string, nameOf: (userId: string) => string): string[] {
  const lines: string[] = [];
  if (after.status !== row.status) lines.push(`${who} set the status to ${STATUS_NAMES[after.status]}.`);
  if (after.priority !== row.priority) lines.push(`${who} set the priority to ${PRIORITY_NAMES[after.priority]}.`);
  if (after.assigneeId !== row.assigneeId) lines.push(after.assigneeId ? `${who} assigned this to ${nameOf(after.assigneeId)}.` : `${who} took this off ${nameOf(row.assigneeId as string)}.`);
  return lines;
}

/** A foreign key checks a row exists, not whose it is: row-level security doesn't apply to it, so this asks as the workspace. */
async function foreignReference(tx: Database, { productId, categoryId }: TicketChanges): Promise<string | null> {
  if (productId && (await tx.select({ id: product.id }).from(product).where(eq(product.id, productId))).length === 0) return "There’s no such product in this workspace.";
  if (categoryId && (await tx.select({ id: category.id }).from(category).where(eq(category.id, categoryId))).length === 0) return "There’s no such category in this workspace.";
  return null;
}

/** Applies changes to tickets by their ids, keeping resolved-at and the conversation's record. Assignees are read off the team first: only someone here can hold a ticket. */
async function applyChanges(services: Services, workspaceId: string, where: (tx: Database) => Promise<TicketRow[]>, changes: TicketChanges, actor: Actor): Promise<{ ok: true; tickets: TicketRow[] } | { ok: false; error: string }> {
  const team = await teamOf(services.db, workspaceId);
  if (changes.assigneeId && !team.some(({ userId }) => userId === changes.assigneeId)) return { ok: false, error: "That person isn’t in this workspace." };
  const nameOf = (userId: string) => team.find((person) => person.userId === userId)?.name ?? "someone who left";
  const who = actor.writtenBy === "assistant" ? `${nameOf(actor.userId)}’s assistant` : nameOf(actor.userId);
  return withWorkspace(services.db, workspaceId, async (tx) => {
    const foreign = await foreignReference(tx, changes);
    if (foreign) return { ok: false, error: foreign };
    const updated: TicketRow[] = [];
    for (const row of await where(tx)) {
      const status = changes.status ?? row.status;
      const priority = changes.priority ?? row.priority;
      const assigneeId = changes.assigneeId === undefined ? row.assigneeId : changes.assigneeId;
      const [saved] = await tx
        .update(ticket)
        .set({ status, priority, assigneeId, categoryId: changes.categoryId === undefined ? row.categoryId : changes.categoryId, productId: changes.productId === undefined ? row.productId : changes.productId, tags: nextTags(row, changes), resolvedAt: resolvedAtAfter(status, row.resolvedAt, services.now()) })
        .where(eq(ticket.id, row.id))
        .returning();
      // One statement each: rows of a single insert could share a timestamp, and these read in order.
      for (const body of changeLines(row, { status, priority, assigneeId }, who, nameOf)) await tx.insert(message).values({ ticketId: row.id, kind: "system", body, authorUserId: actor.userId, writtenBy: actor.writtenBy });
      updated.push(saved);
    }
    return { ok: true, tickets: updated };
  });
}

/** Changes one ticket, by its number. */
export async function updateTicket(services: Services, workspaceId: string, number: number, changes: TicketChanges, actor: Actor) {
  const applied = await applyChanges(services, workspaceId, (tx) => tx.select().from(ticket).where(eq(ticket.number, number)), changes, actor);
  if (!applied.ok) return applied;
  return applied.tickets.length > 0 ? { ok: true as const, ticket: applied.tickets[0] } : { ok: false as const, error: `There’s no ticket #${number} in this workspace.` };
}

/** Changes several at once, from the inbox. An id from elsewhere finds nothing: row-level security hides it. */
export async function updateTickets(services: Services, workspaceId: string, ids: string[], changes: TicketChanges, actor: Actor) {
  if (ids.length === 0) return { ok: false as const, error: "Select some tickets first." };
  const applied = await applyChanges(services, workspaceId, (tx) => tx.select().from(ticket).where(inArray(ticket.id, ids)), changes, actor);
  return applied.ok ? { ok: true as const, count: applied.tickets.length } : applied;
}

/** Ends every requester link already sent for a ticket, for a link that reached the wrong person. New replies carry a new one. */
export async function endRequesterLinks(db: Database, workspaceId: string, number: number): Promise<boolean> {
  const changed = await withWorkspace(db, workspaceId, (tx) =>
    tx
      .update(ticket)
      .set({ linkVersion: sql`${ticket.linkVersion} + 1` })
      .where(eq(ticket.number, number))
      .returning({ id: ticket.id }),
  );
  return changed.length > 0;
}
