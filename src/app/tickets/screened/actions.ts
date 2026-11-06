"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { dismissScreenedMails, promoteScreenedMail } from "@/application/screened-mail";
import type { Tried } from "@/domain/tried";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

function refreshLists() {
  revalidatePath("/tickets/screened");
  revalidatePath("/tickets");
}

/** Opens a ticket from a mail, for the product chosen, and goes to it: answering is usually what comes next. */
export async function promoteAction(id: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const promoted = await promoteScreenedMail(appServices(), seat.workspaceId, seat.userId, id, String(form.get("product") ?? "") || null);
  if (!promoted.ok) return promoted;
  refreshLists();
  redirect(`/tickets/${promoted.number}`);
}

export async function dismissOneAction(id: string): Promise<Tried> {
  const seat = await currentSeat();
  const dismissed = await dismissScreenedMails(appServices(), seat.workspaceId, seat.userId, [id]);
  refreshLists();
  return dismissed;
}

export async function dismissSelectedAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const dismissed = await dismissScreenedMails(appServices(), seat.workspaceId, seat.userId, form.getAll("mail").map(String));
  refreshLists();
  return dismissed;
}
