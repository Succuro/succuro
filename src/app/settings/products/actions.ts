"use server";

import { revalidatePath } from "next/cache";
import { createProduct, deleteProduct, renewPublicKey, updateProduct, type ProductInput } from "@/application/products";
import type { Tried } from "@/domain/tried";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

const PAGE = "/settings/products";

const valuesOf = (form: FormData): ProductInput => ({
  name: String(form.get("name") ?? ""),
  colour: String(form.get("colour") ?? "") || undefined,
  supportAddress: String(form.get("supportAddress") ?? ""),
  senderName: String(form.get("senderName") ?? ""),
});

export async function createProductAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const created = await createProduct(db(), seat.workspaceId, seat.userId, valuesOf(form));
  revalidatePath(PAGE);
  return created;
}

export async function updateProductAction(id: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const updated = await updateProduct(db(), seat.workspaceId, seat.userId, id, valuesOf(form));
  revalidatePath(PAGE);
  return updated;
}

export async function deleteProductAction(id: string): Promise<void> {
  const seat = await currentSeat();
  await deleteProduct(db(), seat.workspaceId, seat.userId, id);
  revalidatePath(PAGE);
}

export async function renewKeyAction(id: string): Promise<void> {
  const seat = await currentSeat();
  await renewPublicKey(db(), seat.workspaceId, seat.userId, id);
  revalidatePath(PAGE);
}
