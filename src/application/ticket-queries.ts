import { and, asc, count, desc, eq, ilike, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { TicketPriority, TicketStatus } from "@/domain/tickets";
import { TICKET_STATUSES } from "@/domain/tickets";
import type { Database } from "@/infrastructure/db/client";
import { category, contact, message, product, ticket } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { containing } from "./contacts";
import { teamOf } from "./team";

export interface TicketFilters {
  status?: TicketStatus;
  productId?: string;
  /** Someone's id, or "none" for tickets nobody holds. "Mine" is the viewer's own id. */
  assignee?: string;
  priority?: TicketPriority;
  categoryId?: string;
  tag?: string;
  search?: string;
}

const NUMBER_SEARCH = /^#?(\d{1,9})$/;

function matchesSearch(search: string): SQL | undefined {
  const number = NUMBER_SEARCH.exec(search);
  const pattern = containing(search);
  return or(
    number ? eq(ticket.number, Number(number[1])) : undefined,
    ilike(ticket.subject, pattern),
    ilike(contact.email, pattern),
    ilike(contact.name, pattern),
    sql`exists (select 1 from ${message} where ${message.ticketId} = ${ticket.id} and ${ilike(message.body, pattern)})`,
  );
}

function assigneeCondition(assignee: string | undefined): SQL | undefined {
  if (!assignee) return undefined;
  return assignee === "none" ? isNull(ticket.assigneeId) : eq(ticket.assigneeId, assignee);
}

/** Everything but the status: the counts per status answer for the other filters as they stand. */
const otherFilters = ({ productId, assignee, priority, categoryId, tag, search }: TicketFilters) =>
  and(productId ? eq(ticket.productId, productId) : undefined, assigneeCondition(assignee), priority ? eq(ticket.priority, priority) : undefined, categoryId ? eq(ticket.categoryId, categoryId) : undefined, tag ? sql`${tag} = any(${ticket.tags})` : undefined, search?.trim() ? matchesSearch(search.trim()) : undefined);

const PAGE = 50;

/** The inbox: a page of tickets, latest activity first, and how many there are per status under the same filters. */
export async function listTickets(db: Database, workspaceId: string, filters: TicketFilters, page = 1) {
  const others = otherFilters(filters);
  return withWorkspace(db, workspaceId, async (tx) => {
    const tickets = await tx
      .select({
        id: ticket.id,
        number: ticket.number,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        tags: ticket.tags,
        channel: ticket.channel,
        assigneeId: ticket.assigneeId,
        lastMessageAt: ticket.lastMessageAt,
        createdAt: ticket.createdAt,
        productName: product.name,
        productColour: product.colour,
        categoryName: category.name,
        contactEmail: contact.email,
        contactName: contact.name,
      })
      .from(ticket)
      .innerJoin(contact, eq(contact.id, ticket.contactId))
      .leftJoin(product, eq(product.id, ticket.productId))
      .leftJoin(category, eq(category.id, ticket.categoryId))
      .where(and(filters.status ? eq(ticket.status, filters.status) : undefined, others))
      .orderBy(desc(ticket.lastMessageAt), desc(ticket.number))
      .limit(PAGE + 1)
      .offset((page - 1) * PAGE);
    const counted = await tx.select({ status: ticket.status, count: count() }).from(ticket).innerJoin(contact, eq(contact.id, ticket.contactId)).where(others).groupBy(ticket.status);
    const counts = Object.fromEntries(TICKET_STATUSES.map((status) => [status, counted.find((row) => row.status === status)?.count ?? 0])) as Record<TicketStatus, number>;
    return { tickets: tickets.slice(0, PAGE), hasMore: tickets.length > PAGE, counts };
  });
}

export type InboxTicket = Awaited<ReturnType<typeof listTickets>>["tickets"][number];

/** One ticket as the team sees it: everything, notes and drafts included. Never reaches a requester: their path is application/requester.ts. */
export async function ticketForTeam(db: Database, workspaceId: string, number: number) {
  const found = await withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx
      .select({ ticket, productName: product.name, productColour: product.colour, productSlug: product.slug, productAddress: product.supportAddress, categoryName: category.name, contact })
      .from(ticket)
      .innerJoin(contact, eq(contact.id, ticket.contactId))
      .leftJoin(product, eq(product.id, ticket.productId))
      .leftJoin(category, eq(category.id, ticket.categoryId))
      .where(eq(ticket.number, number));
    if (!row) return null;
    const messages = await tx.select().from(message).where(eq(message.ticketId, row.ticket.id)).orderBy(asc(message.createdAt), asc(message.id));
    const others = await tx
      .select({ number: ticket.number, subject: ticket.subject, status: ticket.status, lastMessageAt: ticket.lastMessageAt })
      .from(ticket)
      .where(and(eq(ticket.contactId, row.contact.id), ne(ticket.id, row.ticket.id)))
      .orderBy(desc(ticket.lastMessageAt))
      .limit(10);
    return { ...row, messages, others };
  });
  if (!found) return null;
  const team = await teamOf(db, workspaceId);
  const nameOf = (userId: string | null) => (userId ? (team.find((person) => person.userId === userId)?.name ?? "Someone who left") : null);
  return { ...found, assigneeName: nameOf(found.ticket.assigneeId), messages: found.messages.map((entry) => ({ ...entry, authorName: nameOf(entry.authorUserId) })) };
}

export type TeamTicket = NonNullable<Awaited<ReturnType<typeof ticketForTeam>>>;
export type TeamMessage = TeamTicket["messages"][number];

/** Every tag in use in the workspace, for the filter. */
export async function tagsInUse(db: Database, workspaceId: string): Promise<string[]> {
  const rows = await withWorkspace(db, workspaceId, (tx) => tx.selectDistinct({ tag: sql<string>`unnest(${ticket.tags})` }).from(ticket));
  return rows.map(({ tag }) => tag).sort();
}
