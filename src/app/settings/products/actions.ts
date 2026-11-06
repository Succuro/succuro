"use server";

import { revalidatePath } from "next/cache";
import { addProductAddress, removeProductAddress, setAddressScreening } from "@/application/product-addresses";
import { createProduct, deleteProduct, renewPublicKey, updateProduct, type ProductInput } from "@/application/products";
import type { Tried } from "@/domain/tried";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

const PAGE = "/settings/products";

const valuesOf = (form: FormData): ProductInput => ({
  name: String(form.get("name") ?? ""),
  colour: String(form.get("colour") ?? "") || undefined,
  supportAddress: String(form.get("supportAddress") ?? ""),
  screensSupportAddress: form.get("screensSupportAddress") === "on",
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

export async function addAddressAction(productId: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const added = await addProductAddress(db(), seat.workspaceId, seat.userId, productId, String(form.get("value") ?? ""), form.get("screens") === "on");
  revalidatePath(PAGE);
  return added;
}

export async function setScreeningAction(id: string, screens: boolean): Promise<Tried> {
  const seat = await currentSeat();
  const changed = await setAddressScreening(db(), seat.workspaceId, seat.userId, id, screens);
  revalidatePath(PAGE);
  return changed;
}

export async function removeAddressAction(id: string): Promise<void> {
  const seat = await currentSeat();
  await removeProductAddress(db(), seat.workspaceId, seat.userId, id);
  revalidatePath(PAGE);
}
