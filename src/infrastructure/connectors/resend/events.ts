import { parse } from "node-html-parser";
import type { DeliveryOutcome, InboundEmail, MailEvent } from "@/application/ports";
import { messageIdsIn, parseAddress, type MailAuthentication } from "@/domain/email";
import type { NotedAttachment } from "@/infrastructure/db/schema/support";
import { withoutSecrets } from "../without-secrets";

/**
 * What Resend's webhooks and its received-mail API say, turned into this app's own words. A webhook
 * carries only a mail's metadata (https://resend.com/docs/webhooks/emails/received), so the body comes
 * from `GET /emails/receiving/{id}`.
 */

export interface ResendEvent {
  type?: string;
  data?: {
    email_id?: string;
    message_id?: string;
    bounce?: { message?: string };
    failed?: { reason?: string };
  };
}

export interface ReceivedEmail {
  id: string;
  from: string;
  to?: string[];
  cc?: string[];
  received_for?: string[];
  subject?: string;
  text?: string | null;
  html?: string | null;
  headers?: Record<string, unknown>;
  message_id?: string;
  created_at?: string;
  authentication?: MailAuthentication;
  attachments?: { filename?: string; content_type?: string; size?: number }[];
}

const OUTCOMES: Record<string, DeliveryOutcome> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  // Resend refused to try: the address is on its suppression list after an earlier bounce or complaint.
  "email.suppressed": "failed",
};

function reasonIn(event: ResendEvent): string | null {
  const reason = event.data?.bounce?.message ?? event.data?.failed?.reason;
  return reason ? withoutSecrets(reason) : null;
}

export function deliveryEventOf(event: ResendEvent): MailEvent {
  const outcome = OUTCOMES[event.type ?? ""];
  const providerId = event.data?.email_id;
  if (!outcome || !providerId) return { type: "ignored" };
  return { type: "delivery", report: { providerId, outcome, messageId: event.data?.message_id ?? null, detail: reasonIn(event) } };
}

/** The text of a mail that has only HTML: tags gone, and scripts and styles with them, since it is shown as text. */
export function textOfHtml(html: string): string {
  const root = parse(html);
  root.querySelectorAll("script, style, head").forEach((element) => element.remove());
  return root.structuredText.trim();
}

/** Header names as written vary from one mail server to the next. */
const lowercased = (headers: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(" ") : String(value)]));

const attachmentsOf = (email: ReceivedEmail): NotedAttachment[] =>
  (email.attachments ?? []).map((attachment) => ({ filename: attachment.filename ?? "unnamed", contentType: attachment.content_type ?? "unknown", size: attachment.size ?? null }));

/** The service's date, left out when it can't be read: the time it reached this app is close enough then. */
function receivedAtOf({ created_at: at }: ReceivedEmail): { receivedAt?: Date } {
  const date = at ? new Date(at) : null;
  return date && !Number.isNaN(date.getTime()) ? { receivedAt: date } : {};
}

export function inboundEmailOf(email: ReceivedEmail): InboundEmail {
  const headers = lowercased(email.headers);
  const sender = parseAddress(headers.from ?? "") ?? parseAddress(email.from);
  return {
    providerId: email.id,
    from: sender?.address ?? email.from.trim().toLowerCase(),
    fromName: sender?.name ?? null,
    addressedTo: [...(email.to ?? []), ...(email.cc ?? []), ...(email.received_for ?? [])].flatMap((value) => parseAddress(value)?.address ?? []),
    subject: email.subject ?? "",
    text: email.text?.trim() || textOfHtml(email.html ?? ""),
    messageId: email.message_id ?? messageIdsIn(headers["message-id"])[0] ?? null,
    inReplyTo: messageIdsIn(headers["in-reply-to"])[0] ?? null,
    references: messageIdsIn(headers.references),
    headers,
    authentication: email.authentication ?? {},
    attachments: attachmentsOf(email),
    ...receivedAtOf(email),
  };
}
