import { desc, eq, sql } from "drizzle-orm";
import { onlyScopes, READ_SCOPES, type ApiScope } from "@/domain/api-scopes";
import { managesSettings } from "@/domain/team";
import type { Tried } from "@/domain/tried";
import { randomToken, sha256 } from "@/infrastructure/crypto/secrets";
import type { Database } from "@/infrastructure/db/client";
import { apiKey } from "@/infrastructure/db/schema/connections";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { HOUR_LIMITS, secondsUntilNextWindow, takesOneMore } from "./rate-limit";
import { roleIn } from "./team";

/** Keys start with this, so one pasted somewhere it shouldn't be is recognisable. */
const PREFIX = "sk_";

export const NOT_A_MANAGER_OF_KEYS = "Only owners and admins manage API keys.";

export type NewKey = { ok: true; id: string; key: string } | { ok: false; error: string };

/** A new key for another app, able to do only what it was given. Only its hash is kept: the key is shown once. */
export async function createApiKey(db: Database, workspaceId: string, userId: string, name: string, wanted: readonly unknown[]): Promise<NewKey> {
  if (!managesSettings(await roleIn(db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_KEYS };
  const scopes = onlyScopes(wanted);
  if (scopes.length === 0) return { ok: false, error: "Choose what this key may do." };
  const key = `${PREFIX}${randomToken(30)}`;
  const [row] = await withWorkspace(db, workspaceId, (tx) => tx.insert(apiKey).values({ name: name.trim() || "Key", keyHash: sha256(key), prefix: key.slice(0, 10), scopes, createdBy: userId }).returning({ id: apiKey.id }));
  return { ok: true, id: row.id, key };
}

/** A key an assistant may make: it reads and nothing else, whatever it was told. */
export const createReadKey = (db: Database, workspaceId: string, userId: string, name: string) => createApiKey(db, workspaceId, userId, name, READ_SCOPES);

export async function apiKeysOf(db: Database, workspaceId: string) {
  return withWorkspace(db, workspaceId, (tx) => tx.select({ id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix, scopes: apiKey.scopes, lastUsedAt: apiKey.lastUsedAt, createdAt: apiKey.createdAt }).from(apiKey).orderBy(desc(apiKey.createdAt)));
}

/** The keys, for someone asking through a tool: only who could make or end one may see them there. */
export async function apiKeysForManager(db: Database, workspaceId: string, userId: string) {
  if (!managesSettings(await roleIn(db, workspaceId, userId))) return { ok: false as const, error: NOT_A_MANAGER_OF_KEYS };
  return { ok: true as const, keys: await apiKeysOf(db, workspaceId) };
}

/** Ends a key for good: its row goes, and whatever used it stops at once. Another workspace’s key is no key at all from here. */
export async function revokeApiKey(db: Database, workspaceId: string, userId: string, id: string): Promise<Tried> {
  if (!managesSettings(await roleIn(db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_KEYS };
  const ended = await withWorkspace(db, workspaceId, (tx) => tx.delete(apiKey).where(eq(apiKey.id, id)).returning({ id: apiKey.id }));
  return ended.length > 0 ? { ok: true, said: "Key revoked." } : { ok: false, error: "No key with this id in this workspace." };
}

export type KeyAccess = { status: "ok"; workspaceId: string; keyId: string } | { status: "unknown" } | { status: "forbidden" };

/** Which workspace a key opens, for what it's asked to do; read by hash before any workspace is known (trusted path). */
export async function accessOfKey(db: Database, key: string | null, scope: ApiScope): Promise<KeyAccess> {
  // Anything else can't be a key: refused without waking the database.
  if (!key?.startsWith(PREFIX)) return { status: "unknown" };
  const [row] = await db.update(apiKey).set({ lastUsedAt: sql`now()` }).where(eq(apiKey.keyHash, sha256(key))).returning({ id: apiKey.id, workspaceId: apiKey.workspaceId, scopes: apiKey.scopes });
  if (!row) return { status: "unknown" };
  return row.scopes.includes(scope) ? { status: "ok", workspaceId: row.workspaceId, keyId: row.id } : { status: "forbidden" };
}

/** Counts one more ticket through this key this hour, and says how long to wait when it's one too many; null when it fits. */
export async function waitForKey(db: Database, workspaceId: string, keyId: string, now: Date): Promise<number | null> {
  const fits = await withWorkspace(db, workspaceId, (tx) => takesOneMore(tx, `api:${keyId}`, HOUR_LIMITS.ticketsPerKey, now));
  return fits ? null : secondsUntilNextWindow(now);
}

/** The key a request carries in its Authorization header. */
export const bearerOf = (request: Request) => request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
