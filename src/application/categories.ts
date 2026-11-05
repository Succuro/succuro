import { asc, eq, sql } from "drizzle-orm";
import { oneLine } from "@/domain/ticket-input";
import type { Tried } from "@/domain/tried";
import type { Database } from "@/infrastructure/db/client";
import { category } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";

export const categoriesOf = (db: Database, workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select({ id: category.id, name: category.name }).from(category).orderBy(asc(category.position), asc(category.name)));

export async function addCategory(db: Database, workspaceId: string, name: string): Promise<Tried> {
  const named = oneLine(name).slice(0, 60);
  if (!named) return { ok: false, error: "A category needs a name." };
  return withWorkspace(db, workspaceId, async (tx) => {
    if ((await tx.select({ id: category.id }).from(category).where(eq(category.name, named))).length > 0) return { ok: false, error: "This category already exists." };
    await tx.insert(category).values({ name: named, position: sql`(select coalesce(max(position) + 1, 0) from ${category})` });
    return { ok: true, said: `${named} added.` };
  });
}

/** Its tickets stay, without a category. */
export async function removeCategory(db: Database, workspaceId: string, id: string): Promise<boolean> {
  return (await withWorkspace(db, workspaceId, (tx) => tx.delete(category).where(eq(category.id, id)).returning({ id: category.id }))).length > 0;
}
