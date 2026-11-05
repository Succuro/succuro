import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OPTIONS, POST } from "@/app/api/public/tickets/route";
import { HOUR_LIMITS } from "@/application/rate-limit";
import { HONEYPOT_FIELD, receivePublicForm } from "@/application/public-form";
import { deleteProduct, renewPublicKey } from "@/application/products";
import type { Services } from "@/application/services";
import { listTickets } from "@/application/ticket-queries";
import type { Database } from "@/infrastructure/db/client";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { addProduct, NOW, testServices } from "./support/desk";

const shared = vi.hoisted(() => ({ services: undefined as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("@/infrastructure/services", () => ({ appServices: () => shared.services }));

let db: Database;
let services: Services;
beforeAll(async () => {
  db = await createTestDatabase();
  services = testServices(db).services;
  shared.services = services;
});

async function form() {
  const { workspaceId, userId } = await createTestWorkspace(db);
  const product = await addProduct(db, workspaceId, userId);
  return { workspaceId, userId, product, fields: { key: product.publicKey, email: "ada@customer.example", name: "Ada Martin", subject: "It broke", message: "Nothing works." } };
}

const openTickets = async (workspaceId: string) => (await listTickets(db, workspaceId, {})).tickets;

describe("the public form", () => {
  it("opens a ticket for the key's product and workspace, and says only its number", async () => {
    const { workspaceId, product, fields } = await form();
    const answer = await receivePublicForm(services, { ...fields, about: { type: "page", url: "https://acme.example/pricing" }, context: { version: "1.2" } }, "203.0.113.1");
    expect(answer).toEqual({ status: 201, number: 1 });
    expect(await openTickets(workspaceId)).toMatchObject([{ number: 1, subject: "It broke", channel: "web", productName: product.name, contactEmail: "ada@customer.example" }]);
    expect(JSON.stringify(answer)).not.toContain("/t/");
  });

  it("sends no mail at all: an open form mustn't write to whatever address it's given", async () => {
    const { fields } = await form();
    const { services: watched, calls } = testServices(db);
    await receivePublicForm(watched, fields, "203.0.113.1");
    expect(calls).toEqual([]);
  });

  it("accepts a filled honeypot without a word and records nothing", async () => {
    const { workspaceId, fields } = await form();
    expect(await receivePublicForm(services, { ...fields, [HONEYPOT_FIELD]: "https://spam.example" }, "203.0.113.1")).toEqual({ status: 200 });
    expect(await openTickets(workspaceId)).toEqual([]);
  });

  it("answers a filled honeypot without asking the database", async () => {
    const { services: unplugged } = testServices({ select: () => { throw new Error("The database was asked."); } } as never);
    expect(await receivePublicForm(unplugged, { [HONEYPOT_FIELD]: "x" }, null)).toEqual({ status: 200 });
  });

  it("ignores a honeypot left empty, as a person leaves it", async () => {
    const { fields } = await form();
    expect(await receivePublicForm(services, { ...fields, [HONEYPOT_FIELD]: "  " }, "203.0.113.1")).toMatchObject({ status: 201 });
  });

  it.each([
    ["no email", { email: undefined }],
    ["a bad email", { email: "nope" }],
    ["no subject", { subject: "  " }],
    ["no message", { message: "  " }],
    ["a message too long", { message: "x".repeat(20_001) }],
    ["an about link that isn't a web address", { about: { url: "javascript:alert(1)" } }],
    ["a context too big", { context: { blob: "x".repeat(10_000) } }],
    ["a key of the wrong shape", { key: "nope" }],
  ])("refuses %s before anything is recorded", async (_, changes) => {
    const { workspaceId, fields } = await form();
    expect(await receivePublicForm(services, { ...fields, ...changes }, "203.0.113.1")).toMatchObject({ status: 400 });
    expect(await openTickets(workspaceId)).toEqual([]);
  });

  it("refuses a key it doesn't know, one renewed, and a deleted product's", async () => {
    const { workspaceId, userId, product, fields } = await form();
    expect(await receivePublicForm(services, { ...fields, key: "pk_0000000000000000000000000000" }, "203.0.113.1")).toMatchObject({ status: 404 });
    await renewPublicKey(db, workspaceId, userId, product.id);
    expect(await receivePublicForm(services, fields, "203.0.113.1")).toMatchObject({ status: 404 });
    const other = await form();
    await deleteProduct(db, other.workspaceId, other.userId, other.product.id);
    expect(await receivePublicForm(services, other.fields, "203.0.113.1")).toMatchObject({ status: 404 });
  });

  it("files a ticket in the key's workspace only", async () => {
    const mine = await form();
    const theirs = await form();
    await receivePublicForm(services, mine.fields, "203.0.113.1");
    expect(await openTickets(theirs.workspaceId)).toEqual([]);
  });
});

describe("the form's limits", () => {
  it("stop one address after a few requests an hour, and leave others alone", async () => {
    const { workspaceId, fields } = await form();
    for (let sent = 0; sent < HOUR_LIMITS.formFromOneAddress; sent++) expect((await receivePublicForm(services, fields, "203.0.113.1")).status).toBe(201);
    expect(await receivePublicForm(services, fields, "203.0.113.1")).toMatchObject({ status: 429, error: expect.stringContaining("Too many") });
    expect((await receivePublicForm(services, fields, "203.0.113.2")).status).toBe(201);
    expect((await listTickets(db, workspaceId, {})).tickets).toHaveLength(HOUR_LIMITS.formFromOneAddress + 1);
  });

  it("don't lump every visitor together when the address is unknown: only the form's ceiling applies", async () => {
    const { fields } = await form();
    for (let sent = 0; sent <= HOUR_LIMITS.formFromOneAddress; sent++) expect((await receivePublicForm(services, fields, null)).status).toBe(201);
  });

  it("open again the next hour", async () => {
    const { fields } = await form();
    for (let sent = 0; sent <= HOUR_LIMITS.formFromOneAddress; sent++) await receivePublicForm(services, fields, "203.0.113.1");
    const { services: nextHour } = testServices(db, [], new Date(NOW.getTime() + 3_600_000));
    expect((await receivePublicForm(nextHour, fields, "203.0.113.1")).status).toBe(201);
  });

  it("are per product: one flooded form doesn't close another", async () => {
    const mine = await form();
    const theirs = await form();
    for (let sent = 0; sent <= HOUR_LIMITS.formFromOneAddress; sent++) await receivePublicForm(services, mine.fields, "203.0.113.1");
    expect((await receivePublicForm(services, theirs.fields, "203.0.113.1")).status).toBe(201);
  });

  it("hold a whole form to a ceiling, from however many addresses", async () => {
    const { fields } = await form();
    let last = 0;
    for (let sent = 0; sent <= HOUR_LIMITS.formInAll; sent++) last = (await receivePublicForm(services, fields, `198.51.${Math.floor(sent / 250)}.${sent % 250}`)).status;
    expect(last).toBe(429);
  }, 60_000);

  it("keep no address, only a hash of it", async () => {
    const { workspaceId, fields } = await form();
    await receivePublicForm(services, fields, "203.0.113.77");
    const { requestCount } = await import("@/infrastructure/db/schema/support");
    const { withWorkspace } = await import("@/infrastructure/db/tenant");
    expect(JSON.stringify(await withWorkspace(db, workspaceId, (tx) => tx.select().from(requestCount)))).not.toContain("203.0.113.77");
  });
});

describe("the form's address", () => {
  const post = (body: BodyInit, contentType: string, headers: Record<string, string> = {}) => POST(new Request("https://succuro.test/api/public/tickets", { method: "POST", headers: { "content-type": contentType, ...headers }, body }));

  beforeEach(() => {
    shared.services = services;
  });

  it("is open to any website, with no credentials, and answers its preflight without a database", () => {
    const preflight = OPTIONS();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("takes JSON from the widget", async () => {
    const { fields } = await form();
    const response = await post(JSON.stringify(fields), "application/json");
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ received: true, number: 1 });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("takes a plain HTML form", async () => {
    const { fields } = await form();
    const response = await post(new URLSearchParams(fields).toString(), "application/x-www-form-urlencoded");
    expect(response.status).toBe(201);
  });

  it("says what's wrong with what it was sent, and refuses what isn't readable", async () => {
    expect((await post("not json", "application/json")).status).toBe(400);
    const { fields } = await form();
    const response = await post(JSON.stringify({ ...fields, email: "nope" }), "application/json");
    expect(await response.json()).toEqual({ error: expect.stringContaining("email") });
  });

  it("looks at the visitor's address for its limit", async () => {
    const { fields } = await form();
    for (let sent = 0; sent < HOUR_LIMITS.formFromOneAddress; sent++) await post(JSON.stringify(fields), "application/json", { "x-real-ip": "192.0.2.9" });
    expect((await post(JSON.stringify(fields), "application/json", { "x-real-ip": "192.0.2.9" })).status).toBe(429);
    expect((await post(JSON.stringify(fields), "application/json", { "x-forwarded-for": "192.0.2.10, 10.0.0.1" })).status).toBe(201);
  });
});
