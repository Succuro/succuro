"use server";

import { revalidatePath } from "next/cache";
import { addSavedReply, removeSavedReply } from "@/application/saved-replies";
import type { Tried } from "@/domain/tried";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

const PAGE = "/settings/saved-replies";

export async function addSavedReplyAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const added = await addSavedReply(db(), seat.workspaceId, seat.userId, String(form.get("title") ?? ""), String(form.get("body") ?? ""));
  revalidatePath(PAGE);
  return added;
}

export async function removeSavedReplyAction(id: string): Promise<void> {
  const seat = await currentSeat();
  await removeSavedReply(db(), seat.workspaceId, id);
  revalidatePath(PAGE);
}
