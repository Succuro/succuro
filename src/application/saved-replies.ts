import { asc, eq } from "drizzle-orm";
import { bodyInput, firstProblem, oneLine } from "@/domain/ticket-input";
import type { Tried } from "@/domain/tried";
import type { Database } from "@/infrastructure/db/client";
import { savedReply } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";

export const savedRepliesOf = (db: Database, workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select({ id: savedReply.id, title: savedReply.title, body: savedReply.body }).from(savedReply).orderBy(asc(savedReply.title)));

export async function addSavedReply(db: Database, workspaceId: string, userId: string, title: string, text: string): Promise<Tried> {
  const named = oneLine(title).slice(0, 120);
  if (!named) return { ok: false, error: "A saved reply needs a title." };
  const body = bodyInput.safeParse(text);
  if (!body.success) return { ok: false, error: firstProblem(body.error) };
  return withWorkspace(db, workspaceId, async (tx) => {
    if ((await tx.select({ id: savedReply.id }).from(savedReply).where(eq(savedReply.title, named))).length > 0) return { ok: false, error: "A saved reply with this title already exists." };
    await tx.insert(savedReply).values({ title: named, body: body.data, createdBy: userId });
    return { ok: true, said: `${named} saved.` };
  });
}

export async function removeSavedReply(db: Database, workspaceId: string, id: string): Promise<boolean> {
  return (await withWorkspace(db, workspaceId, (tx) => tx.delete(savedReply).where(eq(savedReply.id, id)).returning({ id: savedReply.id }))).length > 0;
}
