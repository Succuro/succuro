import { eq, sql } from "drizzle-orm";
import { CONNECTORS, connectorOf, readFields, type Capability, type Connector, type ConnectorKind } from "@/domain/connectors";
import { managesSettings, NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import type { AdapterClient } from "@/infrastructure/connectors/adapter";
import { adapterOf } from "@/infrastructure/connectors";
import { withoutSecrets } from "@/infrastructure/connectors/without-secrets";
import { open, randomToken, seal, type Credentials } from "@/infrastructure/crypto/secrets";
import { connection } from "@/infrastructure/db/schema/connections";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Services } from "./services";
import { roleIn } from "./team";

/** A connection as a member sees it: never its credentials. */
export interface ConnectionView {
  id: string;
  kind: ConnectorKind;
  name: string;
  label: string;
  status: "connected" | "failing";
  capabilities: readonly Capability[];
  checkedAt: Date | null;
  lastError: string | null;
  /** Where the service posts back. */
  hookUrl: string;
  /** Whether what it posts can be believed yet. */
  signingSecretSaved: boolean;
}

type ConnectionRow = typeof connection.$inferSelect;

/** The signed address a connection's service posts its webhooks to. */
export const hookUrlOf = (services: Pick<Services, "settings">, row: Pick<ConnectionRow, "id" | "hookToken">) => `${new URL(`/api/hooks/${row.id}`, services.settings.BETTER_AUTH_URL)}?token=${row.hookToken}`;

const fieldsOf = (services: Pick<Services, "settings">, row: ConnectionRow): Credentials => ({ ...row.settings, ...open(row.sealedCredentials, services.settings.SUCCURO_SECRETS_KEY) });

export function viewOf(services: Pick<Services, "settings">, row: ConnectionRow): ConnectionView {
  const connector = connectorOf(row.kind) as Connector;
  return {
    id: row.id,
    kind: connector.kind,
    name: connector.name,
    label: row.label,
    status: row.status,
    capabilities: connector.capabilities,
    checkedAt: row.checkedAt,
    lastError: row.lastError,
    hookUrl: hookUrlOf(services, row),
    signingSecretSaved: Boolean(fieldsOf(services, row)[connector.signingSecretField]),
  };
}

export const connectorsOffered = (): readonly Connector[] => CONNECTORS;

export async function connectionsOf(services: Services, workspaceId: string): Promise<ConnectionView[]> {
  const rows = await withWorkspace(services.db, workspaceId, (tx) => tx.select().from(connection).orderBy(connection.kind, connection.label));
  return rows.filter((row) => connectorOf(row.kind)).map((row) => viewOf(services, row));
}

export type Connected = { ok: true; connection: ConnectionView } | { ok: false; error: string };

const isManager = async (services: Services, workspaceId: string, userId: string) => managesSettings(await roleIn(services.db, workspaceId, userId));

/** A check never throws: a service down or a refused key is an answer to show. */
export async function safeCheck(client: AdapterClient) {
  try {
    return await client.check();
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? withoutSecrets(error.message) : "The service didn’t answer." };
  }
}

const contextFor = (services: Services, row: Pick<ConnectionRow, "id" | "hookToken">, fields: Record<string, string>) => ({ fields, hookUrl: hookUrlOf(services, row), fetch: services.fetch, now: services.now });

/** Secret fields are sealed; the others stay readable, for the screens. */
function splitFields(connector: Connector, fields: Record<string, string>): { secrets: Credentials; settings: Record<string, string> } {
  const secretKeys = new Set(connector.fields.filter((field) => field.secret).map((field) => field.key));
  const entries = Object.entries(fields);
  return { secrets: Object.fromEntries(entries.filter(([key]) => secretKeys.has(key))), settings: Object.fromEntries(entries.filter(([key]) => !secretKeys.has(key))) };
}

/**
 * Connects a service from what the member typed: checked against the service first, so a wrong key
 * is said at once rather than at the first send. Typing it again replaces the key and keeps the row,
 * so the address given to the service still works, and a signing secret left empty stays as it was.
 */
export async function connectWithFields(services: Services, workspaceId: string, userId: string, kind: string, values: Record<string, unknown>): Promise<Connected> {
  if (!(await isManager(services, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  const connector = connectorOf(kind);
  if (!connector) return { ok: false, error: "There’s no such service." };
  if (!services.settings.SUCCURO_SECRETS_KEY) return { ok: false, error: "This instance can’t seal credentials yet: its SUCCURO_SECRETS_KEY isn’t set." };
  const read = readFields(connector, values);
  if (!read.ok) return { ok: false, error: `Missing: ${read.missing.join(", ")}.` };
  const hookToken = randomToken(24);
  const check = await safeCheck(adapterOf(connector.kind)(contextFor(services, { id: "pending", hookToken }, read.values)));
  if (!check.ok) return { ok: false, error: check.detail };
  const { secrets, settings } = splitFields(connector, read.values);
  const label = check.label ?? connector.name;
  const earlier = (await withWorkspace(services.db, workspaceId, (tx) => tx.select().from(connection).where(eq(connection.kind, connector.kind)))).find((row) => row.label === label);
  const credentials = { ...(earlier ? open(earlier.sealedCredentials, services.settings.SUCCURO_SECRETS_KEY) : {}), ...secrets };
  const row = await saveConnection(services, workspaceId, { kind: connector.kind, label, credentials, settings, hookToken, userId });
  return { ok: true, connection: viewOf(services, row) };
}

interface NewConnection {
  kind: ConnectorKind;
  label: string;
  credentials: Credentials;
  settings: Record<string, string>;
  hookToken: string;
  userId: string;
}

async function saveConnection(services: Services, workspaceId: string, created: NewConnection): Promise<ConnectionRow> {
  const sealedCredentials = seal(created.credentials, services.settings.SUCCURO_SECRETS_KEY);
  const now = services.now();
  return withWorkspace(services.db, workspaceId, async (tx) => {
    const [row] = await tx
      .insert(connection)
      .values({ kind: created.kind, label: created.label, sealedCredentials, settings: created.settings, hookToken: created.hookToken, connectedBy: created.userId, checkedAt: now })
      .onConflictDoUpdate({
        target: [connection.workspaceId, connection.kind, connection.label],
        set: { sealedCredentials, settings: created.settings, status: "connected", lastError: null, checkedAt: now, updatedAt: sql`now()` },
      })
      .returning();
    return row;
  });
}

/** Saves the secret a service signs its webhooks with, which it only gives once it knows the address. */
export async function saveSigningSecret(services: Services, workspaceId: string, userId: string, connectionId: string, secret: string): Promise<Connected> {
  if (!(await isManager(services, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  const value = secret.trim();
  if (!/^whsec_[A-Za-z0-9+/=]{16,}$/.test(value)) return { ok: false, error: "That doesn’t look like a signing secret: it starts with whsec_." };
  return withWorkspace(services.db, workspaceId, async (tx) => {
    const [row] = await tx.select().from(connection).where(eq(connection.id, connectionId));
    if (!row) return { ok: false, error: "This connection no longer exists." };
    const connector = connectorOf(row.kind) as Connector;
    const credentials = { ...open(row.sealedCredentials, services.settings.SUCCURO_SECRETS_KEY), [connector.signingSecretField]: value };
    const [saved] = await tx
      .update(connection)
      .set({ sealedCredentials: seal(credentials, services.settings.SUCCURO_SECRETS_KEY) })
      .where(eq(connection.id, connectionId))
      .returning();
    return { ok: true, connection: viewOf(services, saved) };
  });
}

/** Asks the service again whether the connection still works, and records the answer. */
export async function checkConnection(services: Services, workspaceId: string, connectionId: string): Promise<ConnectionView | null> {
  const opened = await openConnection(services, workspaceId, connectionId);
  if (!opened) return null;
  const check = await safeCheck(opened.client);
  const [row] = await withWorkspace(services.db, workspaceId, (tx) =>
    tx
      .update(connection)
      .set({ status: check.ok ? "connected" : "failing", lastError: check.ok ? null : check.detail, checkedAt: services.now() })
      .where(eq(connection.id, connectionId))
      .returning(),
  );
  return viewOf(services, row);
}

/** Forgets a connection and its credentials; what it brought in stays. */
export async function disconnect(services: Services, workspaceId: string, userId: string, connectionId: string): Promise<boolean> {
  if (!(await isManager(services, workspaceId, userId))) return false;
  const deleted = await withWorkspace(services.db, workspaceId, (tx) => tx.delete(connection).where(eq(connection.id, connectionId)).returning({ id: connection.id }));
  return deleted.length > 0;
}

export interface OpenedConnection {
  row: ConnectionRow;
  connector: Connector;
  client: AdapterClient;
}

export function clientOf(services: Services, row: ConnectionRow): OpenedConnection {
  const connector = connectorOf(row.kind) as Connector;
  return { row, connector, client: adapterOf(connector.kind)(contextFor(services, row, fieldsOf(services, row))) };
}

/** A connection's client, its credentials opened, ready to talk to its service. */
export async function openConnection(services: Services, workspaceId: string, connectionId: string): Promise<OpenedConnection | null> {
  const [row] = await withWorkspace(services.db, workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, connectionId)));
  return row ? clientOf(services, row) : null;
}

/** The workspace's connection that can do this, opened; failing ones too, since the service may be back and a failure gets said at the send. */
export async function connectionWith(services: Services, workspaceId: string, capability: Capability): Promise<OpenedConnection | null> {
  const rows = await withWorkspace(services.db, workspaceId, (tx) => tx.select().from(connection).orderBy(connection.createdAt));
  const row = rows.find((candidate) => (connectorOf(candidate.kind)?.capabilities as readonly Capability[] | undefined)?.includes(capability));
  return row ? clientOf(services, row) : null;
}

/** Records that the service refused the credentials, so the connections page says so too and not only the reply that hit it. */
export async function markFailing(services: Services, workspaceId: string, connectionId: string, why: string): Promise<void> {
  await withWorkspace(services.db, workspaceId, (tx) => tx.update(connection).set({ status: "failing", lastError: why }).where(eq(connection.id, connectionId)));
}
