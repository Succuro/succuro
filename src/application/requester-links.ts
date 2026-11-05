import { issueRequesterToken } from "@/infrastructure/crypto/requester-token";
import type { Services } from "./services";

/** Every reply carries a fresh link, so a conversation that goes on never loses its way in. */
const LINK_LIFETIME_MS = 90 * 86_400_000;

export interface LinkedTicket {
  id: string;
  workspaceId: string;
  linkVersion: number;
}

/** The page where a requester reads and answers one ticket, without an account. Issued from a given moment, the same link comes out each time. */
export function requesterUrlOf(services: Pick<Services, "settings" | "now">, ticket: LinkedTicket, issuedAt = services.now()): string {
  const expiresAt = new Date(issuedAt.getTime() + LINK_LIFETIME_MS);
  const token = issueRequesterToken({ workspaceId: ticket.workspaceId, ticketId: ticket.id, version: ticket.linkVersion, expiresAt }, services.settings.BETTER_AUTH_SECRET);
  return new URL(`/t/${token}`, services.settings.BETTER_AUTH_URL).toString();
}
