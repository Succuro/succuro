import { createHmac } from "node:crypto";
import { connectWithFields, saveSigningSecret } from "@/application/connections";
import type { InboundEmail, InboundRequest } from "@/application/ports";
import { createProduct, productsOf } from "@/application/products";
import type { Services } from "@/application/services";
import { createTicket } from "@/application/tickets";
import { newTicketInput } from "@/domain/ticket-input";
import type { Database } from "@/infrastructure/db/client";
import type { Env } from "@/infrastructure/env";
import { fakeFetch, type FakeRoute } from "./fetch";

export const NOW = new Date("2026-11-05T09:00:00Z");
export const SECRETS_KEY = Buffer.alloc(32, 1).toString("base64");
export const AUTH_SECRET = "a-long-enough-secret-for-signing-tests-only";
export const WEBHOOK_SECRET = `whsec_${Buffer.from("a signing secret for tests only").toString("base64")}`;

export const testSettings = { BETTER_AUTH_URL: "https://succuro.test", BETTER_AUTH_SECRET: AUTH_SECRET, SUCCURO_SECRETS_KEY: SECRETS_KEY, SUCCURO_ADMINS: "founder@example.com" } as Env;

export const RESEND_DOMAINS: FakeRoute = { match: "GET https://api.resend.com/domains", json: { object: "list", data: [{ id: "d1", name: "acme.example", capabilities: { sending: "enabled", receiving: "enabled" } }] } };
export const RESEND_SENDS: FakeRoute = { match: "POST https://api.resend.com/emails", json: { id: "resend-sent-1" } };

/** Services for a test: a clock that holds still, and a fake Resend that accepts what a healthy one would. */
export function testServices(db: Database, routes: FakeRoute[] = [RESEND_DOMAINS, RESEND_SENDS], now = NOW) {
  const network = fakeFetch(routes);
  const services: Services = { db, settings: testSettings, fetch: network.fetch, now: () => now };
  return { services, calls: network.calls };
}

/** A Resend connection, its signing secret saved. */
export async function connectResend(services: Services, workspaceId: string, userId: string) {
  const made = await connectWithFields(services, workspaceId, userId, "resend", { apiKey: "re_test_key" });
  if (!made.ok) throw new Error(made.error);
  await saveSigningSecret(services, workspaceId, userId, made.connection.id, WEBHOOK_SECRET);
  return made.connection;
}

/** A product with an address, named Acme App unless told otherwise. */
export async function addProduct(db: Database, workspaceId: string, userId: string, name = "Acme App", supportAddress = "support@acme.example") {
  const added = await createProduct(db, workspaceId, userId, { name, supportAddress, senderName: `${name} support` });
  if (!added.ok) throw new Error(added.error);
  return (await productsOf(db, workspaceId)).find((row) => row.name === name) as Awaited<ReturnType<typeof productsOf>>[number];
}

/** A ticket from an app, as its API would open it. */
export async function openTicket(services: Services, workspaceId: string, overrides: Record<string, unknown> = {}) {
  const input = newTicketInput.parse({ subject: "It broke", message: "Nothing works since this morning.", requester: { email: "ada@customer.example", name: "Ada Martin" }, ...overrides });
  const created = await createTicket(services, workspaceId, input, { channel: "api" });
  if (!created.ok) throw new Error(created.error);
  return created;
}

/** A request as Resend would sign it: computed here from its documented scheme, not with the code under test. */
export function signedRequest(body: string, { secret = WEBHOOK_SECRET, at = NOW, id = "msg_1" }: { secret?: string; at?: Date; id?: string } = {}): InboundRequest {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { method: "POST", url: "https://succuro.test/api/hooks/x", headers: new Headers({ "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` }), body };
}

/** A mail a person sent to the product's address, unless a test says otherwise. */
export function inboundEmail(overrides: Partial<InboundEmail> = {}): InboundEmail {
  return {
    providerId: `received-${crypto.randomUUID()}`,
    from: "ada@customer.example",
    fromName: "Ada Martin",
    addressedTo: ["support@acme.example"],
    subject: "Help please",
    text: "I can’t sign in.",
    messageId: `<${crypto.randomUUID()}@customer.example>`,
    inReplyTo: null,
    references: [],
    headers: {},
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    attachments: [],
    ...overrides,
  };
}
