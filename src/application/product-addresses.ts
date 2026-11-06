import { asc, eq } from "drizzle-orm";
import { addressRuleValue, type AddressRule } from "@/domain/mail-routing";
import type { Tried } from "@/domain/tried";
import type { Database } from "@/infrastructure/db/client";
import { product, productAddress } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { refusedProductChange } from "./products";

/** All that mail can be routed by, in the caller's workspace transaction: support addresses first, since replies come back to them. */
export async function addressRulesOf(tx: Database): Promise<AddressRule[]> {
  const products = await tx.select({ productId: product.id, value: product.supportAddress, screens: product.screensSupportAddress }).from(product);
  const others = await tx.select({ productId: productAddress.productId, value: productAddress.value, screens: productAddress.screens }).from(productAddress);
  return [...products.flatMap(({ productId, value, screens }) => (value ? [{ productId, value, screens }] : [])), ...others];
}

export const productAddressesOf = (db: Database, workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(productAddress).orderBy(asc(productAddress.value)));

export type ProductAddress = Awaited<ReturnType<typeof productAddressesOf>>[number];

/** Which product already holds this, if one does: a mail must mean one product, not whichever was added last. */
async function holderOf(tx: Database, value: string): Promise<string | null> {
  const [support] = await tx.select({ name: product.name }).from(product).where(eq(product.supportAddress, value));
  if (support) return support.name;
  const [other] = await tx.select({ name: product.name }).from(productAddress).innerJoin(product, eq(product.id, productAddress.productId)).where(eq(productAddress.value, value));
  return other?.name ?? null;
}

/** Points an address or a domain at a product. The product is looked up as the workspace, since a foreign key would accept another's. */
export async function addProductAddress(db: Database, workspaceId: string, actorId: string, productId: string, typed: string, screens: boolean): Promise<Tried> {
  const refusal = await refusedProductChange(db, workspaceId, actorId);
  if (refusal) return { ok: false, error: refusal };
  const value = addressRuleValue(typed);
  if (!value) return { ok: false, error: "Type an address like help@acme.example, or a domain like acme.example." };
  return withWorkspace(db, workspaceId, async (tx) => {
    const [owner] = await tx.select({ name: product.name }).from(product).where(eq(product.id, productId));
    if (!owner) return { ok: false, error: "This product no longer exists." };
    const holder = await holderOf(tx, value);
    if (holder) return { ok: false, error: `${value} already points to ${holder}.` };
    const added = await tx.insert(productAddress).values({ productId, value, screens }).onConflictDoNothing().returning({ id: productAddress.id });
    return added.length > 0 ? { ok: true, said: `${value} now points to ${owner.name}.` } : { ok: false, error: `${value} was just added to a product.` };
  });
}

/** Whether new mail on this one waits in Screened or opens a ticket. */
export async function setAddressScreening(db: Database, workspaceId: string, actorId: string, id: string, screens: boolean): Promise<Tried> {
  const refusal = await refusedProductChange(db, workspaceId, actorId);
  if (refusal) return { ok: false, error: refusal };
  const changed = await withWorkspace(db, workspaceId, (tx) => tx.update(productAddress).set({ screens }).where(eq(productAddress.id, id)).returning({ value: productAddress.value }));
  if (changed.length === 0) return { ok: false, error: "This address no longer points to a product." };
  return { ok: true, said: screens ? `New mail on ${changed[0].value} now waits in Screened.` : `New mail on ${changed[0].value} now opens a ticket.` };
}

/** New mail on it goes to Screened from then on: taking one off loses nothing. */
export async function removeProductAddress(db: Database, workspaceId: string, actorId: string, id: string): Promise<boolean> {
  if (await refusedProductChange(db, workspaceId, actorId)) return false;
  return (await withWorkspace(db, workspaceId, (tx) => tx.delete(productAddress).where(eq(productAddress.id, id)).returning({ id: productAddress.id }))).length > 0;
}
