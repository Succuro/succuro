"use server";

import { revalidatePath } from "next/cache";
import { saveNoticePreference } from "@/application/notifications";
import { setAssistantMaySend } from "@/application/workspace-settings";
import type { Tried } from "@/domain/tried";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

/** What this member wants to be mailed about: their own choice, so any member can make it. */
export async function saveNoticesAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const saved = await saveNoticePreference(appServices().db, seat.workspaceId, seat.userId, form.get("enabled") === "on", form.getAll("product").map(String));
  revalidatePath("/settings");
  return saved;
}

/** Whether an assistant may send. Only here: no tool reaches it, so a prompt can't loosen it. */
export async function saveAssistantSendingAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const saved = await setAssistantMaySend(appServices().db, seat.workspaceId, seat.userId, form.get("assistantMaySend") === "yes");
  revalidatePath("/settings");
  return saved;
}
