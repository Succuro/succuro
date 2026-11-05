"use server";

import { revalidatePath } from "next/cache";
import { addCategory, removeCategory } from "@/application/categories";
import type { Tried } from "@/domain/tried";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

const PAGE = "/settings/categories";

export async function addCategoryAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const added = await addCategory(db(), seat.workspaceId, String(form.get("name") ?? ""));
  revalidatePath(PAGE);
  return added;
}

export async function removeCategoryAction(id: string): Promise<void> {
  const seat = await currentSeat();
  await removeCategory(db(), seat.workspaceId, id);
  revalidatePath(PAGE);
}
