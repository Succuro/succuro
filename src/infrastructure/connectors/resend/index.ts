import type { Check, InboundRequest, MailEvent, OutgoingEmail } from "@/application/ports";
import type { Adapter, AdapterContext } from "../adapter";
import { checked } from "../checked";
import { bearerJson, requestJson } from "../http";
import { forgedWebhook, parseWebhook } from "../webhooks";
import { deliveryEventOf, inboundEmailOf, type ReceivedEmail, type ResendEvent } from "./events";
import { signatureHolds } from "./signature";

const API = "https://api.resend.com";
const NAME = "Resend";

interface DomainList {
  data?: { capabilities?: { receiving?: string } }[];
}

/** Listing domains takes a full-access key, which reading received mail needs too: a sending key is caught here rather than at the first mail. */
async function checkKey({ fetch, fields }: AdapterContext): Promise<Check> {
  const { data = [] } = await requestJson<DomainList>(fetch, NAME, `${API}/domains`, { headers: bearerJson(fields.apiKey) });
  const receiving = data.filter((domain) => domain.capabilities?.receiving === "enabled").length;
  return { ok: true, detail: `${data.length} domains, ${receiving} receiving mail.`, label: NAME };
}

/**
 * A reply to someone who wrote in. This tool answers people; it never sends cold mail, which Resend's
 * terms forbid and nothing here would allow: every mail starts from a ticket a person opened.
 */
async function sendEmail({ fetch, fields }: AdapterContext, email: OutgoingEmail): Promise<{ providerId: string }> {
  const thread = email.inReplyTo ? { headers: { "In-Reply-To": email.inReplyTo, References: email.references?.join(" ") ?? email.inReplyTo } } : {};
  const sent = await requestJson<{ id: string }>(fetch, NAME, `${API}/emails`, {
    method: "POST",
    headers: { ...bearerJson(fields.apiKey), "Idempotency-Key": email.idempotencyKey },
    body: JSON.stringify({ from: email.from, to: [email.to], reply_to: email.replyTo, subject: email.subject, text: email.text, ...thread }),
  });
  return { providerId: sent.id };
}

/** Checks the signature first: nothing unsigned costs a call to Resend, or reaches a ticket. */
async function readWebhook({ fetch, fields, now }: AdapterContext, request: InboundRequest): Promise<MailEvent> {
  const { headers, body } = request;
  const signed = { id: headers.get("svix-id"), timestamp: headers.get("svix-timestamp"), signature: headers.get("svix-signature"), body };
  if (!signatureHolds(fields.webhookSecret, signed, now())) throw forgedWebhook(NAME);
  const event = parseWebhook<ResendEvent>(NAME, body);
  if (event.type !== "email.received") return deliveryEventOf(event);
  const id = event.data?.email_id;
  if (!id) return { type: "ignored" };
  const email = await requestJson<ReceivedEmail>(fetch, NAME, `${API}/emails/receiving/${encodeURIComponent(id)}`, { headers: bearerJson(fields.apiKey) });
  return { type: "received", email: inboundEmailOf({ ...email, id }) };
}

export const resendAdapter: Adapter = (context) => ({
  check: () => checked(NAME, () => checkKey(context)),
  sendEmail: (email) => sendEmail(context, email),
  readWebhook: (request) => readWebhook(context, request),
});
