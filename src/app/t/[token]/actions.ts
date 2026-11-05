"use server";

import { revalidatePath } from "next/cache";
import { answerAsRequester } from "@/application/requester";
import type { Tried } from "@/domain/tried";
import { appServices } from "@/infrastructure/services";

/** A requester's answer. The token is the only thing that lets them in, and it's checked again here. */
export async function answerAction(token: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const answered = await answerAsRequester(appServices(), token, String(form.get("body") ?? ""));
  if (answered.ok) revalidatePath(`/t/${token}`);
  return answered;
}
