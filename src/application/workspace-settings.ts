import { sql } from "drizzle-orm";
import { managesSettings, NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import type { Tried } from "@/domain/tried";
import type { Database } from "@/infrastructure/db/client";
import { workspaceSettings } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { roleIn } from "./team";

export interface WorkspaceSettings {
  assistantMaySend: boolean;
}

/** How this workspace works, with the careful defaults until a member changes them. */
export async function settingsOf(db: Database, workspaceId: string): Promise<WorkspaceSettings> {
  const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(workspaceSettings));
  return { assistantMaySend: row?.assistantMaySend ?? false };
}

/**
 * Whether an assistant may send a reply once its member said yes. Only the settings screen calls
 * this, for an owner or admin: no tool reaches it, because what customers write can carry instructions.
 */
export async function setAssistantMaySend(db: Database, workspaceId: string, actorId: string, allowed: boolean): Promise<Tried> {
  if (!managesSettings(await roleIn(db, workspaceId, actorId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  await withWorkspace(db, workspaceId, (tx) =>
    tx
      .insert(workspaceSettings)
      .values({ assistantMaySend: allowed })
      .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: { assistantMaySend: allowed, updatedAt: sql`now()` } }),
  );
  return { ok: true, said: allowed ? "Assistants may now send a reply once their member said yes." : "Replies now wait for a member to send them." };
}
