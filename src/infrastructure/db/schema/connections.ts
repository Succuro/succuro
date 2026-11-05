import { index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, tenantIsolation, updatedAt, workspaceColumn } from "./shared";
import { workspace } from "./tenancy";

// ─── Connections ───────────────────────────────────────────────────────────
//
// The services a workspace connected, and the keys other apps reach it with. Credentials are
// sealed per row (see infrastructure/crypto), never kept in environment variables.

export const connectionStatus = pgEnum("connection_status", ["connected", "failing"]);

export const connection = pgTable(
  "connection",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn().references(() => workspace.id, { onDelete: "cascade" }),
    /** The connector's kind in the catalogue (domain/connectors). */
    kind: text().notNull(),
    /** What to call it. */
    label: text().notNull(),
    status: connectionStatus().notNull().default("connected"),
    /** Keys and signing secrets, sealed with the instance's secrets key. */
    sealedCredentials: text().notNull(),
    /** What isn't secret. */
    settings: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** Signs the address a service posts its webhooks to; checked before anything is read. */
    hookToken: text().notNull(),
    connectedBy: text().references(() => user.id, { onDelete: "set null" }),
    checkedAt: timestamp({ withTimezone: true }),
    /** The last check's answer when it failed, in the member's words. */
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.workspaceId, table.kind, table.label), tenantIsolation()],
).enableRLS();

/** A key another app reaches a workspace with; only its hash is kept. */
export const apiKey = pgTable(
  "api_key",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn().references(() => workspace.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** SHA-256 of the key, hex; the key itself is shown once, when it is made. */
    keyHash: text().notNull().unique(),
    /** The key's first characters, to tell keys apart in the list. */
    prefix: text().notNull(),
    /** What it may do (domain/api-scopes): a dashboard's key has no business opening tickets. */
    scopes: text().array().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    lastUsedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index().on(table.workspaceId), tenantIsolation()],
).enableRLS();
