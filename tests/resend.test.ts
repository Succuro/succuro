import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resendAdapter } from "@/infrastructure/connectors/resend";
import { inboundEmailOf, textOfHtml } from "@/infrastructure/connectors/resend/events";
import { signatureHolds } from "@/infrastructure/connectors/resend/signature";
import { NOW, signedRequest, WEBHOOK_SECRET } from "./support/desk";
import { fakeFetch, type FakeRoute } from "./support/fetch";

const FIELDS = { apiKey: "re_test_key", webhookSecret: WEBHOOK_SECRET };

function client(routes: FakeRoute[] = [], fields: Record<string, string> = FIELDS) {
  const network = fakeFetch(routes);
  return { adapter: resendAdapter({ fields, hookUrl: "https://succuro.test/api/hooks/x?token=t", fetch: network.fetch, now: () => NOW }), calls: network.calls };
}

describe("a signature", () => {
  const body = '{"type":"email.received"}';
  const signed = (overrides = {}) => {
    const { headers } = signedRequest(body, overrides);
    return { id: headers.get("svix-id"), timestamp: headers.get("svix-timestamp"), signature: headers.get("svix-signature"), body };
  };

  it("holds when it was made with the secret, over this very body", () => {
    expect(signatureHolds(WEBHOOK_SECRET, signed(), NOW)).toBe(true);
  });

  it("matches the published scheme byte for byte", () => {
    // The scheme itself, written out: id.timestamp.body, HMAC-SHA256, keyed with the base64 after whsec_.
    const key = Buffer.from("any key will do for this");
    const [id, timestamp, payload] = ["msg_1", "1614265330", '{"test": 2432232314}'];
    const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest("base64");
    expect(signatureHolds(`whsec_${key.toString("base64")}`, { id, timestamp, signature: `v1,${signature}`, body: payload }, new Date(1614265330_000))).toBe(true);
  });

  it("takes any of several, as a rotation sends them", () => {
    const good = signed();
    expect(signatureHolds(WEBHOOK_SECRET, { ...good, signature: `v1,bm90IHRoaXMgb25l ${good.signature}` }, NOW)).toBe(true);
  });

  it.each([
    ["another secret", { secret: `whsec_${Buffer.from("someone else").toString("base64")}` }, {}],
    ["another body", {}, { body: '{"type":"email.bounced"}' }],
    ["no signature", {}, { signature: null }],
    ["no id", {}, { id: null }],
    ["no timestamp", {}, { timestamp: null }],
    ["an unknown version", {}, { signature: "v2,abc" }],
  ])("doesn't hold with %s", (_, made, changes) => {
    expect(signatureHolds(WEBHOOK_SECRET, { ...signed(made), ...changes }, NOW)).toBe(false);
  });

  it("doesn't hold without a saved secret", () => {
    expect(signatureHolds(undefined, signed(), NOW)).toBe(false);
  });

  it("doesn't hold when it's too old or from the future, so an old one can't be played again", () => {
    expect(signatureHolds(WEBHOOK_SECRET, signed({ at: new Date(NOW.getTime() - 6 * 60_000) }), NOW)).toBe(false);
    expect(signatureHolds(WEBHOOK_SECRET, signed({ at: new Date(NOW.getTime() + 6 * 60_000) }), NOW)).toBe(false);
    expect(signatureHolds(WEBHOOK_SECRET, signed({ at: new Date(NOW.getTime() - 4 * 60_000) }), NOW)).toBe(true);
  });
});

describe("checking a key", () => {
  it("says how many domains it can see, and names the connection", async () => {
    const { adapter, calls } = client([{ match: "GET https://api.resend.com/domains", json: { data: [{ capabilities: { receiving: "enabled" } }, { capabilities: { receiving: "disabled" } }] } }]);
    expect(await adapter.check()).toEqual({ ok: true, detail: "2 domains, 1 receiving mail.", label: "Resend" });
    expect(calls[0].headers.get("authorization")).toBe("Bearer re_test_key");
  });

  it("says plainly when the key is refused, a sending-only one included", async () => {
    const { adapter } = client([{ match: "GET https://api.resend.com/domains", status: 401, json: { name: "restricted_api_key", message: "This API key is restricted to only send emails" } }]);
    expect(await adapter.check()).toEqual({ ok: false, detail: "Resend refused the credentials: This API key is restricted to only send emails" });
  });
});

describe("sending", () => {
  const MAIL = { from: "Acme <support@acme.example>", replyTo: "support+abc@acme.example", to: "ada@customer.example", subject: "Re: Help", text: "Hello", idempotencyKey: "key-1" };

  it("posts the threaded mail with its idempotency key, and returns the provider's id", async () => {
    const { adapter, calls } = client([{ match: "POST https://api.resend.com/emails", json: { id: "sent-1" } }]);
    const sent = await adapter.sendEmail?.({ ...MAIL, inReplyTo: "<b@x>", references: ["<a@x>", "<b@x>"] });
    expect(sent).toEqual({ providerId: "sent-1" });
    expect(calls[0].headers.get("idempotency-key")).toBe("key-1");
    expect(JSON.parse(calls[0].body)).toEqual({ from: MAIL.from, to: [MAIL.to], reply_to: MAIL.replyTo, subject: MAIL.subject, text: MAIL.text, headers: { "In-Reply-To": "<b@x>", References: "<a@x> <b@x>" } });
  });

  it("adds no thread headers to a first mail", async () => {
    const { adapter, calls } = client([{ match: "POST https://api.resend.com/emails", json: { id: "sent-1" } }]);
    await adapter.sendEmail?.(MAIL);
    expect(JSON.parse(calls[0].body)).not.toHaveProperty("headers");
  });

  it("throws what the service said", async () => {
    const { adapter } = client([{ match: "POST https://api.resend.com/emails", status: 403, json: { message: "The acme.example domain is not verified." } }]);
    await expect(adapter.sendEmail?.(MAIL)).rejects.toThrow("The acme.example domain is not verified.");
  });
});

describe("reading a webhook", () => {
  const RECEIVED = JSON.stringify({ type: "email.received", data: { email_id: "mail-1", from: "ada@customer.example", to: ["support@acme.example"], subject: "Help", attachments: [] } });
  const FULL = { id: "mail-1", from: "ada@customer.example", to: ["support+tok@acme.example"], cc: ["team@acme.example"], received_for: ["support@acme.example"], subject: "Help", text: "Hello there", html: null, headers: { From: "Ada Martin <ada@customer.example>", "In-Reply-To": "<a@x>", References: "<z@x> <a@x>", "Auto-Submitted": "no" }, message_id: "<new@customer.example>", authentication: { spf: "pass", dkim: "pass", dmarc: "pass" }, attachments: [{ filename: "invoice.pdf", content_type: "application/pdf", size: 2048 }] };
  const FETCHES_MAIL = { match: "GET https://api.resend.com/emails/receiving/mail-1", json: FULL };

  it("refuses an unsigned or forged one before calling anyone", async () => {
    const { adapter, calls } = client([FETCHES_MAIL]);
    await expect(adapter.readWebhook?.({ method: "POST", url: "x", headers: new Headers(), body: RECEIVED })).rejects.toMatchObject({ status: 401 });
    await expect(adapter.readWebhook?.(signedRequest(RECEIVED, { secret: `whsec_${Buffer.from("wrong").toString("base64")}` }))).rejects.toMatchObject({ status: 401 });
    expect(calls).toEqual([]);
  });

  it("refuses everything until a signing secret is saved", async () => {
    const { adapter } = client([FETCHES_MAIL], { apiKey: "re_test_key" });
    await expect(adapter.readWebhook?.(signedRequest(RECEIVED))).rejects.toMatchObject({ status: 401 });
  });

  it("fetches the body of a received mail, which the webhook doesn't carry, and reads its headers", async () => {
    const { adapter, calls } = client([FETCHES_MAIL]);
    const event = await adapter.readWebhook?.(signedRequest(RECEIVED));
    expect(calls[0].url).toBe("https://api.resend.com/emails/receiving/mail-1");
    expect(event).toMatchObject({
      type: "received",
      email: { providerId: "mail-1", from: "ada@customer.example", fromName: "Ada Martin", addressedTo: ["support+tok@acme.example", "team@acme.example", "support@acme.example"], text: "Hello there", messageId: "<new@customer.example>", inReplyTo: "<a@x>", references: ["<z@x>", "<a@x>"], attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", size: 2048 }] },
    });
  });

  it("reads when the service received a mail, and leaves it out when it can't be read", async () => {
    const read = (created_at?: string) => inboundEmailOf({ id: "mail-1", from: "ada@customer.example", created_at }).receivedAt;
    expect(read("2026-10-15T18:41:46.119Z")).toEqual(new Date("2026-10-15T18:41:46.119Z"));
    expect(read("not a date")).toBeUndefined();
    expect(read()).toBeUndefined();
  });

  it("makes the service send it again when the mail can't be fetched", async () => {
    const { adapter } = client([{ match: "GET https://api.resend.com/emails/receiving/mail-1", status: 500, json: { message: "Down" } }]);
    await expect(adapter.readWebhook?.(signedRequest(RECEIVED))).rejects.toMatchObject({ status: 500 });
  });

  it.each([
    ["email.sent", "sent"],
    ["email.delivered", "delivered"],
    ["email.delivery_delayed", "delayed"],
    ["email.bounced", "bounced"],
    ["email.complained", "complained"],
    ["email.failed", "failed"],
    ["email.suppressed", "failed"],
  ])("reads %s as a report of %s", async (type, outcome) => {
    const body = JSON.stringify({ type, data: { email_id: "sent-1", message_id: "<sent@resend>", bounce: { message: "No such mailbox" } } });
    expect(await client().adapter.readWebhook?.(signedRequest(body))).toEqual({ type: "delivery", report: { providerId: "sent-1", outcome, messageId: "<sent@resend>", detail: "No such mailbox" } });
  });

  it("ignores what it has no use for, and what it can't place", async () => {
    expect(await client().adapter.readWebhook?.(signedRequest(JSON.stringify({ type: "email.opened", data: { email_id: "x" } })))).toEqual({ type: "ignored" });
    expect(await client().adapter.readWebhook?.(signedRequest(JSON.stringify({ type: "email.received", data: {} })))).toEqual({ type: "ignored" });
    expect(await client().adapter.readWebhook?.(signedRequest(JSON.stringify({ type: "contact.created" })))).toEqual({ type: "ignored" });
  });

  it("says a signed body it can't read is the sender's to send again", async () => {
    await expect(client().adapter.readWebhook?.(signedRequest("not json"))).rejects.toMatchObject({ status: 400 });
  });
});

describe("a received mail's text", () => {
  it("comes from its HTML when it has no text, without its scripts and styles", () => {
    expect(textOfHtml("<html><head><style>p{color:red}</style></head><body><p>Hello</p><script>alert(1)</script><p>there</p></body></html>")).toBe("Hello\nthere");
    expect(inboundEmailOf({ id: "1", from: "a@b.example", text: null, html: "<p>Only HTML</p>" }).text).toBe("Only HTML");
  });

  it("copes with a mail saying almost nothing", () => {
    expect(inboundEmailOf({ id: "1", from: "A@B.example" })).toMatchObject({ from: "a@b.example", fromName: null, text: "", subject: "", messageId: null, inReplyTo: null, references: [], attachments: [] });
  });

  it("falls back on the Message-ID header, and names an attachment that has no name", () => {
    expect(inboundEmailOf({ id: "1", from: "a@b.example", headers: { "Message-ID": "<h@x>" }, attachments: [{}] })).toMatchObject({ messageId: "<h@x>", attachments: [{ filename: "unnamed", contentType: "unknown", size: null }] });
  });
});
