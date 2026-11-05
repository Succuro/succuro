import type { MailAuthentication } from "@/domain/email";
import type { NotedAttachment } from "@/infrastructure/db/schema/support";

/**
 * What the use cases ask of a connected service, one port per capability. Each adapter in
 * `infrastructure/connectors` implements `ConnectorClient` and the ports of the capabilities its
 * connector lists; the use cases never know which provider is behind a port.
 */

/** Whether the service accepts what was saved, and what to call the connection. */
export interface Check {
  ok: boolean;
  /** Why not, or what was found, in the member's words. */
  detail: string;
  /** A name for the connection. */
  label?: string;
}

export interface ConnectorClient {
  check(): Promise<Check>;
}

export interface OutgoingEmail {
  from: string;
  /** Where answers go: carries the ticket's token, which is what finds it again whatever the mail client does to its headers. */
  replyTo: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  /** Sent twice with the same key, a mail leaves once. */
  idempotencyKey: string;
}

export interface EmailSender {
  /** The provider's id for it. */
  sendEmail(email: OutgoingEmail): Promise<{ providerId: string }>;
}

/** A mail someone sent to a support address, as read from the service. */
export interface InboundEmail {
  /** The service's id for this mail: the same one posted twice is recorded once. */
  providerId: string;
  from: string;
  fromName: string | null;
  /** Everywhere it was addressed to: to, cc and what the service says it received it for. */
  addressedTo: string[];
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** With names lowercased. */
  headers: Record<string, string>;
  authentication: MailAuthentication;
  attachments: NotedAttachment[];
}

export type DeliveryOutcome = "sent" | "delivered" | "delayed" | "bounced" | "complained" | "failed";

/** What became of a reply, as the service reported it. */
export interface DeliveryReport {
  providerId: string;
  outcome: DeliveryOutcome;
  /** The reply's Message-ID, which the send itself doesn't return and answers to it will name. */
  messageId: string | null;
  detail: string | null;
}

export type MailEvent = { type: "received"; email: InboundEmail } | { type: "delivery"; report: DeliveryReport } | { type: "ignored" };

export interface InboundRequest {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

export interface MailEventReader {
  /** What a request a service posted says, after checking it really came from the service. Throws on a forged or unreadable one. */
  readWebhook(request: InboundRequest): Promise<MailEvent>;
}
