import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { tryCheck } from "@/application/connection-use";
import { checkConnection, connectionsOf, connectionWith, connectorsOffered, connectWithFields, disconnect, markFailing, openConnection, safeCheck, saveSigningSecret } from "@/application/connections";
import { connectorOf, readFields } from "@/domain/connectors";
import { open } from "@/infrastructure/crypto/secrets";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { connection } from "@/infrastructure/db/schema/connections";
import { member } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { RESEND_DOMAINS, SECRETS_KEY, testServices, WEBHOOK_SECRET } from "./support/desk";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

const rowOf = async (workspaceId: string) => (await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection)))[0];

describe("the catalogue", () => {
  it("offers what mail goes through, and knows what each field is", () => {
    expect(connectorsOffered().map(({ kind }) => kind)).toEqual(["resend"]);
    expect(connectorOf("nope")).toBeUndefined();
    const resend = connectorOf("resend");
    expect(resend?.capabilities).toEqual(["send_email", "receive_email"]);
    expect(resend?.fields.every(({ secret }) => secret)).toBe(true);
  });

  it("reads what was typed: an optional field left empty stays out, so it can't overwrite anything", () => {
    const resend = connectorOf("resend") as NonNullable<ReturnType<typeof connectorOf>>;
    expect(readFields(resend, { apiKey: " re_x ", webhookSecret: " " })).toEqual({ ok: true, values: { apiKey: "re_x" } });
    expect(readFields(resend, {})).toEqual({ ok: false, missing: ["API key"] });
    expect(readFields(resend, { apiKey: 42 })).toEqual({ ok: false, missing: ["API key"] });
  });
});

describe("connecting", () => {
  it("checks with the service first, seals the key, and shows it nowhere", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services, calls } = testServices(db);
    const made = await connectWithFields(services, workspaceId, userId, "resend", { apiKey: "re_the_key" });
    expect(made).toMatchObject({ ok: true, connection: { kind: "resend", label: "Resend", status: "connected", name: "Resend", signingSecretSaved: false } });
    expect(JSON.stringify(made)).not.toContain("re_the_key");
    expect(calls[0].headers.get("authorization")).toBe("Bearer re_the_key");
    const row = await rowOf(workspaceId);
    expect(row.sealedCredentials).not.toContain("re_the_key");
    expect(open(row.sealedCredentials, SECRETS_KEY)).toEqual({ apiKey: "re_the_key" });
    expect(row.settings).toEqual({});
    expect(row.connectedBy).toBe(userId);
  });

  it("says what's wrong, and saves nothing, when the service refuses", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = testServices(db, [{ match: "GET https://api.resend.com/domains", status: 401, json: { message: "API key is invalid" } }]);
    expect(await connectWithFields(services, workspaceId, userId, "resend", { apiKey: "wrong" })).toEqual({ ok: false, error: expect.stringContaining("API key is invalid") });
    expect(await rowOf(workspaceId)).toBeUndefined();
  });

  it("wants its fields, and a service that exists", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = testServices(db);
    expect(await connectWithFields(services, workspaceId, userId, "resend", {})).toEqual({ ok: false, error: "Missing: API key." });
    expect(await connectWithFields(services, workspaceId, userId, "nope", {})).toMatchObject({ ok: false });
  });

  it("gives the service a signed address, where the token is the connection's own", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = testServices(db);
    const made = await connectWithFields(services, workspaceId, userId, "resend", { apiKey: "re_key" });
    if (!made.ok) throw new Error(made.error);
    const row = await rowOf(workspaceId);
    expect(made.connection.hookUrl).toBe(`https://succuro.test/api/hooks/${row.id}?token=${row.hookToken}`);
  });

  it("keeps the row and the address when connected again, and the signing secret when left empty", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = testServices(db);
    const first = await connectWithFields(services, workspaceId, userId, "resend", { apiKey: "re_old", webhookSecret: WEBHOOK_SECRET });
    const again = await connectWithFields(services, workspaceId, userId, "resend", { apiKey: "re_new" });
    if (!first.ok || !again.ok) throw new Error("Not connected");
    expect(again.connection.hookUrl).toBe(first.connection.hookUrl);
    expect(open((await rowOf(workspaceId)).sealedCredentials, SECRETS_KEY)).toEqual({ apiKey: "re_new", webhookSecret: WEBHOOK_SECRET });
    expect(await connectionsOf(services, workspaceId)).toHaveLength(1);
  });

  it("says so when the instance can't seal anything yet", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = testServices(db);
    const unsealed = { ...services, settings: { ...services.settings, SUCCURO_SECRETS_KEY: undefined } };
    expect(await connectWithFields(unsealed, workspaceId, userId, "resend", { apiKey: "re_x" })).toMatchObject({ ok: false, error: expect.stringContaining("SUCCURO_SECRETS_KEY") });
  });

  it("is for owners and admins", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = testServices(db);
    const plain = crypto.randomUUID();
    await db.insert(user).values({ id: plain, name: "Bea", email: `${plain}@example.test` });
    await db.insert(member).values({ workspaceId, userId: plain, role: "member" });
    expect(await connectWithFields(services, workspaceId, plain, "resend", { apiKey: "re_x" })).toMatchObject({ ok: false, error: expect.stringContaining("owners and admins") });
    const made = await connectWithFields(services, workspaceId, userId, "resend", { apiKey: "re_x" });
    if (!made.ok) throw new Error(made.error);
    expect(await saveSigningSecret(services, workspaceId, plain, made.connection.id, WEBHOOK_SECRET)).toMatchObject({ ok: false });
    expect(await disconnect(services, workspaceId, plain, made.connection.id)).toBe(false);
  });
});

describe("the signing secret", () => {
  async function connected() {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = testServices(db);
    const made = await connectWithFields(services, workspaceId, userId, "resend", { apiKey: "re_key" });
    if (!made.ok) throw new Error(made.error);
    return { workspaceId, userId, services, id: made.connection.id };
  }

  it("is saved sealed, beside the key, and the connection says it has one", async () => {
    const { workspaceId, userId, services, id } = await connected();
    expect(await saveSigningSecret(services, workspaceId, userId, id, ` ${WEBHOOK_SECRET} `)).toMatchObject({ ok: true, connection: { signingSecretSaved: true } });
    const row = await rowOf(workspaceId);
    expect(row.sealedCredentials).not.toContain("whsec_");
    expect(open(row.sealedCredentials, SECRETS_KEY)).toEqual({ apiKey: "re_key", webhookSecret: WEBHOOK_SECRET });
  });

  it("is refused when it can't be one", async () => {
    const { workspaceId, userId, services, id } = await connected();
    expect(await saveSigningSecret(services, workspaceId, userId, id, "not-a-secret")).toMatchObject({ ok: false });
    expect((await connectionsOf(services, workspaceId))[0].signingSecretSaved).toBe(false);
  });

  it("can't be set on another workspace's connection", async () => {
    const mine = await connected();
    const theirs = await connected();
    expect(await saveSigningSecret(mine.services, mine.workspaceId, mine.userId, theirs.id, WEBHOOK_SECRET)).toMatchObject({ ok: false });
  });
});

describe("a connection in use", () => {
  async function connected(routes = [RESEND_DOMAINS]) {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = testServices(db, routes);
    const made = await connectWithFields(services, workspaceId, userId, "resend", { apiKey: "re_key" });
    if (!made.ok) throw new Error(made.error);
    return { workspaceId, userId, services, id: made.connection.id };
  }

  it("is found by what it can do, a failing one included", async () => {
    const { workspaceId, services, id } = await connected();
    expect((await connectionWith(services, workspaceId, "send_email"))?.row.id).toBe(id);
    await markFailing(services, workspaceId, id, "Refused");
    expect((await connectionWith(services, workspaceId, "send_email"))?.row.status).toBe("failing");
    expect(await connectionWith(testServices(db).services, (await createTestWorkspace(db)).workspaceId, "send_email")).toBeNull();
  });

  it("is checked again, and recovers", async () => {
    const { workspaceId, services, id } = await connected();
    await markFailing(services, workspaceId, id, "Refused");
    expect(await tryCheck(services, workspaceId, id)).toEqual({ ok: true, said: "Resend answers." });
    expect((await rowOf(workspaceId)).status).toBe("connected");
    const { services: broken } = testServices(db, [{ match: "GET https://api.resend.com/domains", status: 401, json: { message: "Revoked" } }]);
    expect(await tryCheck(broken, workspaceId, id)).toEqual({ ok: false, error: expect.stringContaining("Revoked") });
    expect(await rowOf(workspaceId)).toMatchObject({ status: "failing", lastError: expect.stringContaining("Revoked") });
    expect(await checkConnection(services, workspaceId, crypto.randomUUID())).toBeNull();
    expect(await tryCheck(services, workspaceId, crypto.randomUUID())).toMatchObject({ ok: false });
  });

  it("stays in its workspace, and is forgotten when disconnected", async () => {
    const mine = await connected();
    const theirs = await connected();
    expect(await openConnection(mine.services, mine.workspaceId, theirs.id)).toBeNull();
    expect(await disconnect(mine.services, mine.workspaceId, mine.userId, theirs.id)).toBe(false);
    expect(await disconnect(mine.services, mine.workspaceId, mine.userId, mine.id)).toBe(true);
    expect((await withWorkspace(db, mine.workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, mine.id))))).toEqual([]);
    expect(await openConnection(theirs.services, theirs.workspaceId, theirs.id)).not.toBeNull();
  });

  it("answers a check that throws with words, never a raw failure", async () => {
    expect(await safeCheck({ check: () => Promise.reject(new Error("No route")) })).toEqual({ ok: false, detail: "No route" });
    expect(await safeCheck({ check: () => Promise.reject("nothing") })).toEqual({ ok: false, detail: "The service didn’t answer." });
  });
});
