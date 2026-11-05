/** What a ticket is and how it moves. Pure rules: the use cases and the screens both read them. */

export const TICKET_STATUSES = ["open", "pending", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const STATUS_NAMES: Record<TicketStatus, string> = { open: "Open", pending: "Pending", resolved: "Resolved", closed: "Closed" };

/** What each status means for the team. */
export const STATUS_MEANINGS: Record<TicketStatus, string> = { open: "Waiting on support", pending: "Waiting on the requester", resolved: "Answered and settled", closed: "Filed away" };

/** What a status means for the person who wrote in. */
export const STATUS_FOR_REQUESTER: Record<TicketStatus, string> = { open: "We’ll get back to you", pending: "We’re waiting for your answer", resolved: "Marked as solved", closed: "Closed" };

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const PRIORITY_NAMES: Record<TicketPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export const TICKET_CHANNELS = ["email", "web", "api", "assistant"] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

export const CHANNEL_NAMES: Record<TicketChannel, string> = { email: "Email", web: "Web form", api: "App", assistant: "Assistant" };

/** What a new workspace sorts its tickets by, until it decides otherwise. */
export const DEFAULT_CATEGORIES = ["Question", "Bug", "Billing", "Account", "Feature request", "Other"] as const;

export const isSettled = (status: TicketStatus) => status === "resolved" || status === "closed";

/** When a ticket counts as resolved once its status changes: the first time it settled, until it opens again. */
export function resolvedAtAfter(status: TicketStatus, resolvedAt: Date | null, now: Date): Date | null {
  return isSettled(status) ? (resolvedAt ?? now) : null;
}

/** Anything the requester writes puts the ball back with support, on a closed ticket too: people answer late, and that must not be lost. */
export const STATUS_AFTER_REQUESTER_WROTE: TicketStatus = "open";

/** A reply that left waits on the requester, unless the member settled the ticket as they sent it. */
export const statusAfterReply = (chosen: TicketStatus | undefined): TicketStatus => chosen ?? "pending";

/** A new ticket's number, from the last one taken in this workspace. */
export const FIRST_TICKET_NUMBER = 1;
