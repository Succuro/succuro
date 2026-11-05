import type { TicketFilters } from "@/application/ticket-queries";
import { TICKET_PRIORITIES, TICKET_STATUSES, type TicketPriority, type TicketStatus } from "@/domain/tickets";

export type InboxQuery = Record<string, string | string[] | undefined>;

const one = (query: InboxQuery, name: string) => {
  const value = query[name];
  return typeof value === "string" && value !== "" ? value : undefined;
};

const UUID = /^[0-9a-f-]{36}$/i;
const uuidIn = (query: InboxQuery, name: string) => {
  const value = one(query, name);
  return value && UUID.test(value) ? value : undefined;
};

/** The status tab shown: an inbox opens on what waits for the team. */
export const statusTab = (query: InboxQuery): TicketStatus | "all" => {
  const asked = one(query, "status");
  if (asked === "all") return "all";
  return (TICKET_STATUSES as readonly string[]).includes(asked ?? "") ? (asked as TicketStatus) : "open";
};

/** The filters an address asks for. Anything it can't mean is dropped: it comes from the address bar. */
export function filtersOf(query: InboxQuery, viewerId: string): TicketFilters {
  const tab = statusTab(query);
  const priority = one(query, "priority");
  const assignee = one(query, "assignee");
  return {
    status: tab === "all" ? undefined : tab,
    productId: uuidIn(query, "product"),
    categoryId: uuidIn(query, "category"),
    assignee: assignee === "me" ? viewerId : assignee,
    priority: (TICKET_PRIORITIES as readonly string[]).includes(priority ?? "") ? (priority as TicketPriority) : undefined,
    tag: one(query, "tag"),
    search: one(query, "q"),
  };
}

export const pageOf = (query: InboxQuery) => Math.max(Math.trunc(Number(one(query, "page"))) || 1, 1);

/** This view's address with some of its query changed; undefined takes a value out. */
export function inboxHref(query: InboxQuery, changes: Record<string, string | undefined>): string {
  const next = new URLSearchParams();
  for (const [name, value] of Object.entries({ ...query, ...changes })) if (typeof value === "string" && value !== "") next.set(name, value);
  const rendered = next.toString();
  return rendered ? `/tickets?${rendered}` : "/tickets";
}
