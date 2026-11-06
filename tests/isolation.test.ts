import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApiKey } from "@/application/api-keys";
import { addCategory } from "@/application/categories";
import { addNote } from "@/application/conversation";
import { saveNoticePreference } from "@/application/notifications";
import { recordInboundMail } from "@/application/inbound-mail";
import { addProductAddress } from "@/application/product-addresses";
import { receivePublicForm } from "@/application/public-form";
import { addSavedReply } from "@/application/saved-replies";
import { setAssistantMaySend } from "@/application/workspace-settings";
import { inviteToWorkspace } from "@/application/invitations";
import type { Database } from "@/infrastructure/db/client";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { addProduct, connectResend, inboundEmail, openTicket, testServices } from "./support/desk";

/**
 * Isolation is checked against the database itself, not a list kept by hand: a new table that isn't
 * in `TRUSTED_TABLES` and lacks row-level security, a policy, a grant or its rows here fails this file.
 */

/** Read before any workspace is known, or owned by Better Auth. Everything else belongs to a workspace. */
const TRUSTED_TABLES = ["account", "jwks", "member", "oauth_access_token", "oauth_client", "oauth_client_assertion", "oauth_client_resource", "oauth_consent", "oauth_refresh_token", "oauth_resource", "rate_limit", "session", "user", "verification", "workspace"];

let db: Database;
let tables: string[];
let mine: Awaited<ReturnType<typeof createTestWorkspace>>;
let theirs: Awaited<ReturnType<typeof createTestWorkspace>>;

const rowsOf = (result: unknown) => (result as { rows: Record<string, unknown>[] }).rows;
const query = async (statement: ReturnType<typeof sql>, on: Database = db) => rowsOf(await on.execute(statement));

/** One workspace's rows in every table it can have them. */
async function stock(workspaceId: string, userId: string) {
  const { services } = testServices(db);
  const product = await addProduct(db, workspaceId, userId);
  await connectResend(services, workspaceId, userId);
  const made = await createApiKey(db, workspaceId, userId, "Key", ["tickets:create"]);
  if (!made.ok) throw new Error(made.error);
  const { number } = await openTicket(services, workspaceId, { product: product.slug });
  await addNote(services, workspaceId, number, "A note", { userId, writtenBy: "member" });
  await addCategory(db, workspaceId, "Refunds");
  await addSavedReply(db, workspaceId, userId, "Reset", "Use the link.");
  await setAssistantMaySend(db, workspaceId, userId, false);
  await saveNoticePreference(db, workspaceId, userId, true, []);
  await receivePublicForm(services, { key: product.publicKey, email: "bea@customer.example", subject: "From the form", message: "Hello" }, "203.0.113.1");
  await inviteToWorkspace(services, workspaceId, userId, "new@customer.example", "member");
  await addProductAddress(db, workspaceId, userId, product.id, "site.example", true);
  await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ["nobody@elsewhere.example"] }));
}

beforeAll(async () => {
  db = await createTestDatabase();
  mine = await createTestWorkspace(db, "Mine");
  theirs = await createTestWorkspace(db, "Theirs");
  await stock(mine.workspaceId, mine.userId);
  await stock(theirs.workspaceId, theirs.userId);
  const found = await query(sql`select tablename from pg_tables where schemaname = 'public' order by 1`);
  tables = found.map(({ tablename }) => tablename as string).filter((name) => !TRUSTED_TABLES.includes(name));
});

describe("every table that belongs to a workspace", () => {
  it("is found: this file can't pass by looking at nothing", () => {
    expect(tables).toEqual(expect.arrayContaining(["product_address", "screened_mail", "api_key", "category", "connection", "contact", "invitation", "message", "notification_preference", "product", "request_count", "saved_reply", "ticket", "ticket_counter", "workspace_settings"]));
  });

  it("has row-level security on, and the tenant policy", async () => {
    for (const table of tables) {
      const [state] = await query(sql`select relrowsecurity from pg_class where oid = ${`public.${table}`}::regclass`);
      expect(state.relrowsecurity, `${table} has no row-level security`).toBe(true);
      const policies = await query(sql`select qual, with_check, roles::text as roles from pg_policies where schemaname = 'public' and tablename = ${table}`);
      expect(policies, `${table} has no policy`).toHaveLength(1);
      expect(policies[0].qual, table).toContain("app_workspace_id()");
      expect(policies[0].with_check, table).toContain("app_workspace_id()");
      expect(policies[0].roles, table).toContain("tenant_app");
    }
  });

  it("carries the workspace it belongs to", async () => {
    for (const table of tables) {
      const columns = await query(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table} and column_name = 'workspace_id'`);
      expect(columns, `${table} has no workspace_id`).toHaveLength(1);
    }
  });

  it("shows a workspace its own rows and nobody else's", async () => {
    for (const table of tables) {
      const name = sql.identifier(table);
      for (const [here, there] of [[mine.workspaceId, theirs.workspaceId], [theirs.workspaceId, mine.workspaceId]]) {
        const seen = await withWorkspace(db, here, (tx) => query(sql`select workspace_id from ${name}`, tx));
        expect(seen.length, `${table} has no rows to test with: stock it above`).toBeGreaterThan(0);
        expect(seen.every(({ workspace_id }) => workspace_id === here), `${table} shows another workspace's rows`).toBe(true);
        const [{ count }] = await withWorkspace(db, here, (tx) => query(sql`select count(*)::int as count from ${name} where workspace_id = ${there}`, tx));
        expect(count, `${table} answers about another workspace`).toBe(0);
      }
    }
  });

  it("won't update or delete another workspace's rows", async () => {
    for (const table of tables) {
      const name = sql.identifier(table);
      const [before] = await query(sql`select count(*)::int as count from ${name} where workspace_id = ${theirs.workspaceId}`);
      const deleted = await withWorkspace(db, mine.workspaceId, (tx) => query(sql`delete from ${name} where workspace_id = ${theirs.workspaceId} returning 1`, tx));
      expect(deleted, table).toEqual([]);
      const [after] = await query(sql`select count(*)::int as count from ${name} where workspace_id = ${theirs.workspaceId}`);
      expect(after.count, `${table} lost rows to another workspace`).toBe(before.count);
    }
  });

  it("won't take a row written into another workspace", async () => {
    await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(sql`insert into category (workspace_id, name) values (${theirs.workspaceId}, 'Planted')`))).rejects.toThrow();
    await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(sql`update category set workspace_id = ${theirs.workspaceId} where name = 'Refunds'`))).rejects.toThrow();
  });

  it("shows nothing at all with no workspace set, even as the app role", async () => {
    for (const table of tables) {
      const rows = await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('role', 'tenant_app', true)`);
        return query(sql`select 1 from ${sql.identifier(table)}`, tx);
      });
      expect(rows, table).toEqual([]);
    }
  });
});

describe("what stays with the trusted path", () => {
  it("can't be written by the app role: memberships, workspaces and identity", async () => {
    for (const statement of [sql`insert into member (workspace_id, user_id, role) values (${mine.workspaceId}, ${theirs.userId}, 'owner')`, sql`update workspace set name = 'Stolen'`, sql`update "user" set email = 'x@y.example'`]) {
      await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(statement))).rejects.toThrow();
    }
  });

  it("can't be read by the app role when it's identity or an assistant's tokens", async () => {
    for (const table of ["user", "session", "account", "oauth_access_token", "oauth_client", "jwks"]) {
      await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(sql`select 1 from ${sql.identifier(table)}`)), table).rejects.toThrow();
    }
  });

  it("is a list that only names tables that exist, so it can't hide a mistake", async () => {
    const existing = (await query(sql`select tablename from pg_tables where schemaname = 'public'`)).map(({ tablename }) => tablename);
    for (const table of TRUSTED_TABLES) expect(existing, `${table} no longer exists: take it off the list`).toContain(table);
  });
});
