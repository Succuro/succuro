import { beforeAll, describe, expect, it, vi } from "vitest";
import { GET as figuresRoute } from "@/app/api/v1/figures/route";
import { POST as ticketsRoute } from "@/app/api/v1/tickets/route";
import { accessOfKey, apiKeysOf, createApiKey, revokeApiKey } from "@/application/api-keys";
import { addCategory } from "@/application/categories";
import { HOUR_LIMITS, hourWindowOf, secondsUntilNextWindow } from "@/application/rate-limit";
import type { Services } from "@/application/services";
import { listTickets, ticketForTeam } from "@/application/ticket-queries";
import { sha256 } from "@/infrastructure/crypto/secrets";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { requestCount } from "@/infrastructure/db/schema/support";
import { member } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
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

async function keyed(scopes: string[] = ["tickets:create", "figures:read"]) {
  const seat = await createTestWorkspace(db);
  const made = await createApiKey(db, seat.workspaceId, seat.userId, "Billing app", scopes);
  if (!made.ok) throw new Error(made.error);
  return { ...seat, key: made.key, keyId: made.id };
}

const BODY = { subject: "Refund", message: "Please refund order 42.", requester: { email: "Ada@Customer.Example", name: "Ada Martin", externalId: "user_42" } };

const post = (key: string | null, body: unknown = BODY) => ticketsRoute(new Request("https://succuro.test/api/v1/tickets", { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) }));
const figures = (key: string | null, query = "") => figuresRoute(new Request(`https://succuro.test/api/v1/figures${query}`, { headers: key ? { authorization: `Bearer ${key}` } : {} }));

describe("an API key", () => {
  it("is shown once and kept only as a hash", async () => {
    const { workspaceId, key } = await keyed();
    expect(key).toMatch(/^sk_[\w-]{40}$/);
    const [listed] = await apiKeysOf(db, workspaceId);
    expect(listed).toMatchObject({ name: "Billing app", prefix: key.slice(0, 10), scopes: ["tickets:create", "figures:read"], lastUsedAt: null });
    expect(JSON.stringify(listed)).not.toContain(key);
    expect(JSON.stringify(listed)).not.toContain(sha256(key));
  });

  it("must be given something to do, and takes only what exists", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    expect(await createApiKey(db, workspaceId, userId, "Nothing", [])).toMatchObject({ ok: false });
    expect(await createApiKey(db, workspaceId, userId, "Too much", ["members:manage", "settings:write"])).toMatchObject({ ok: false });
    expect(await createApiKey(db, workspaceId, userId, "Mixed", ["figures:read", "members:manage"])).toMatchObject({ ok: true });
    expect((await apiKeysOf(db, workspaceId))[0].scopes).toEqual(["figures:read"]);
  });

  it("is made and revoked by an owner or admin only", async () => {
    const { workspaceId, keyId } = await keyed();
    const plain = crypto.randomUUID();
    await db.insert(user).values({ id: plain, name: "Bea", email: `${plain}@example.test` });
    await db.insert(member).values({ workspaceId, userId: plain, role: "member" });
    expect((await createApiKey(db, workspaceId, plain, "Mine", ["figures:read"])).ok).toBe(false);
    expect(await revokeApiKey(db, workspaceId, plain, keyId)).toBe(false);
  });

  it("opens only its own workspace", async () => {
    const { workspaceId, key } = await keyed();
    expect(await accessOfKey(db, key, "tickets:create")).toEqual({ status: "ok", workspaceId, keyId: expect.any(String) });
  });

  it("does only what it was given", async () => {
    const dashboard = await keyed(["figures:read"]);
    const app = await keyed(["tickets:create"]);
    expect(await accessOfKey(db, dashboard.key, "tickets:create")).toEqual({ status: "forbidden" });
    expect((await post(dashboard.key)).status).toBe(403);
    expect((await listTickets(db, dashboard.workspaceId, {})).tickets).toEqual([]);
    expect(await accessOfKey(db, app.key, "figures:read")).toEqual({ status: "forbidden" });
    expect((await figures(app.key)).status).toBe(403);
    expect((await figures(dashboard.key)).status).toBe(200);
    expect((await post(app.key)).status).toBe(201);
  });

  it("stops the moment it's revoked", async () => {
    const { workspaceId, userId, key, keyId } = await keyed();
    expect(await revokeApiKey(db, workspaceId, userId, keyId)).toBe(true);
    expect((await post(key)).status).toBe(401);
  });

  it("is refused without a word about why, when absent, unknown or of another sort", async () => {
    for (const given of [null, "sk_unknown", "garbage", "pk_public"]) expect((await post(given)).status).toBe(401);
    for (const given of [null, "sk_unknown"]) expect((await figures(given)).status).toBe(401);
  });

  it("isn't even looked up when it can't be one: nothing wakes the database", async () => {
    const unplugged = { update: () => { throw new Error("The database was asked."); } } as never;
    expect(await accessOfKey(unplugged, "garbage", "figures:read")).toEqual({ status: "unknown" });
    expect(await accessOfKey(unplugged, null, "figures:read")).toEqual({ status: "unknown" });
  });

  it("can't revoke across workspaces", async () => {
    const mine = await keyed();
    const theirs = await keyed();
    expect(await revokeApiKey(db, mine.workspaceId, mine.userId, theirs.keyId)).toBe(false);
    expect((await post(theirs.key)).status).toBe(201);
  });
});

describe("POST /api/v1/tickets", () => {
  it("opens a ticket with what the app knows, and gives back its number and the requester's link", async () => {
    const { workspaceId, userId, key } = await keyed();
    const product = await addProduct(db, workspaceId, userId);
    await addCategory(db, workspaceId, "Refunds");
    const response = await post(key, { ...BODY, product: product.slug, category: "Refunds", priority: "high", tags: ["Billing", "billing", " VIP "], about: { type: "order", id: "42", title: "Order 42", url: "https://shop.acme.example/orders/42" }, context: { page: "/orders/42", version: "3.1.0", os: "macOS" } });
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toEqual({ id: expect.any(String), number: 1, status: "open", requesterUrl: expect.stringMatching(/^https:\/\/succuro\.test\/t\//) });
    const found = await ticketForTeam(db, workspaceId, 1);
    expect(found?.ticket).toMatchObject({ channel: "api", priority: "high", tags: ["billing", "vip"], aboutType: "order", aboutId: "42", aboutTitle: "Order 42", aboutUrl: "https://shop.acme.example/orders/42", context: { page: "/orders/42", version: "3.1.0", os: "macOS" }, status: "open" });
    expect(found?.contact).toMatchObject({ email: "ada@customer.example", name: "Ada Martin", externalId: "user_42" });
    expect(found).toMatchObject({ productName: product.name, categoryName: "Refunds" });
    expect(found?.messages).toMatchObject([{ kind: "customer", body: "Please refund order 42." }]);
  });

  it("numbers tickets per workspace", async () => {
    const mine = await keyed();
    const theirs = await keyed();
    expect((await (await post(mine.key)).json()).number).toBe(1);
    expect((await (await post(mine.key)).json()).number).toBe(2);
    expect((await (await post(theirs.key)).json()).number).toBe(1);
  });

  it("gives every ticket its own number when several arrive at once", async () => {
    const { key } = await keyed();
    const numbers = await Promise.all(Array.from({ length: 8 }, async () => (await (await post(key)).json()).number));
    expect(numbers.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("can't file a ticket under another workspace's product", async () => {
    const mine = await keyed();
    const theirs = await keyed();
    const product = await addProduct(db, theirs.workspaceId, theirs.userId, "Theirs");
    const response = await post(mine.key, { ...BODY, product: product.slug });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: expect.stringContaining("no product") });
  });

  it("says what's wrong with what it was sent", async () => {
    const { key } = await keyed();
    expect((await post(key, "not json")).status).toBe(400);
    expect((await post(key, { ...BODY, requester: { email: "nope" } })).status).toBe(400);
    expect(await (await post(key, { ...BODY, subject: "" })).json()).toEqual({ error: expect.stringContaining("subject") });
    expect((await post(key, { ...BODY, about: { url: "javascript:alert(1)" } })).status).toBe(400);
    expect((await post(key, { ...BODY, category: "No such" })).status).toBe(422);
  });
});

describe("the limit on a key", () => {
  /** Puts this key's count for the hour just under the limit: reaching it for real takes 600 requests, which the browser proof makes. */
  async function nearTheLimit(workspaceId: string, keyId: string, count = HOUR_LIMITS.ticketsPerKey - 1) {
    await withWorkspace(db, workspaceId, (tx) => tx.insert(requestCount).values({ bucket: `api:${keyId}`, windowStart: hourWindowOf(NOW), count }));
  }

  it("answers 429 past it, saying when to come back, and opens nothing", async () => {
    const { workspaceId, key, keyId } = await keyed();
    await nearTheLimit(workspaceId, keyId);
    expect((await post(key)).status).toBe(201);
    const refused = await post(key);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe(String(secondsUntilNextWindow(NOW)));
    expect(await refused.json()).toEqual({ error: expect.stringContaining("too many") });
    expect((await listTickets(db, workspaceId, {})).tickets).toHaveLength(1);
  });

  it("is per key: another key of the same workspace goes on", async () => {
    const { workspaceId, userId, key, keyId } = await keyed();
    await nearTheLimit(workspaceId, keyId, HOUR_LIMITS.ticketsPerKey);
    expect((await post(key)).status).toBe(429);
    const other = await createApiKey(db, workspaceId, userId, "Other app", ["tickets:create"]);
    if (!other.ok) throw new Error(other.error);
    expect((await post(other.key)).status).toBe(201);
  });

  it("holds for this hour, and opens again the next", async () => {
    const { workspaceId, key, keyId } = await keyed();
    await nearTheLimit(workspaceId, keyId, HOUR_LIMITS.ticketsPerKey);
    expect((await post(key)).status).toBe(429);
    shared.services = testServices(db, [], new Date(NOW.getTime() + 3_600_000)).services;
    expect((await post(key)).status).toBe(201);
    shared.services = services;
  });

  it("counts what it refuses too: a client in a loop doesn't get free requests by sending nonsense", async () => {
    const { workspaceId, key, keyId } = await keyed();
    await nearTheLimit(workspaceId, keyId);
    expect((await post(key, "not json")).status).toBe(400);
    expect((await post(key)).status).toBe(429);
  });

  it("isn't reached by a key without the scope, or by figures", async () => {
    const { workspaceId, key, keyId } = await keyed(["figures:read"]);
    await nearTheLimit(workspaceId, keyId, HOUR_LIMITS.ticketsPerKey);
    expect((await post(key)).status).toBe(403);
    expect((await figures(key)).status).toBe(200);
  });

  it("says how long is left in the hour, never zero", () => {
    expect(secondsUntilNextWindow(new Date("2026-11-05T09:00:00Z"))).toBe(3600);
    expect(secondsUntilNextWindow(new Date("2026-11-05T09:59:30Z"))).toBe(30);
    expect(secondsUntilNextWindow(new Date("2026-11-05T09:59:59.900Z"))).toBe(1);
  });
});

describe("a failed notification", () => {
  it("doesn't fail the request: the app still gets its ticket", async () => {
    const { workspaceId, key } = await keyed();
    const { services: failing } = testServices(db, [{ match: "POST https://api.resend.com/emails/batch", status: 500, json: { message: "Down" } }]);
    shared.services = { ...failing, settings: { ...failing.settings, RESEND_API_KEY: "re_instance", SUCCURO_MAIL_FROM: "Desk <no-reply@succuro.test>" } };
    const response = await post(key);
    shared.services = services;
    expect(response.status).toBe(201);
    const { number } = await response.json();
    expect((await ticketForTeam(db, workspaceId, number))?.messages.at(-1)).toMatchObject({ kind: "system", body: expect.stringContaining("couldn’t be mailed") });
  });
});

describe("GET /api/v1/figures", () => {
  it("answers with the documented shape, and no names or addresses", async () => {
    const { workspaceId, userId, key } = await keyed();
    const product = await addProduct(db, workspaceId, userId);
    await post(key, { ...BODY, product: product.slug });
    const response = await figures(key, "?days=2");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ workspace: { id: workspaceId, name: expect.any(String) }, timezone: "UTC", products: [{ slug: product.slug, name: product.name }] });
    expect(body.products[0].days).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("customer.example");
  });

  it.each([["?days=0", 30], ["?days=abc", 30], ["?days=9999", 365], ["", 30]])("reads %s as a sensible period", async (query, days) => {
    const { workspaceId, userId, key } = await keyed();
    await addProduct(db, workspaceId, userId);
    const { products } = await (await figures(key, query)).json();
    expect(products[0].days).toHaveLength(query === "?days=0" ? 30 : days);
  });

  it("can be asked about one product", async () => {
    const { workspaceId, userId, key } = await keyed();
    await addProduct(db, workspaceId, userId, "One");
    const two = await addProduct(db, workspaceId, userId, "Two");
    const { products } = await (await figures(key, `?product=${two.slug}`)).json();
    expect(products.map(({ name }: { name: string }) => name)).toEqual(["Two"]);
  });
});
