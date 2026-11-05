import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { emailAddress, firstProblem, oneLine } from "@/domain/ticket-input";
import { managesSettings, NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import type { Tried } from "@/domain/tried";
import { randomToken } from "@/infrastructure/crypto/secrets";
import type { Database } from "@/infrastructure/db/client";
import { product } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { roleIn } from "./team";

const productInput = z.object({
  name: z.string().transform(oneLine).pipe(z.string().min(1, "a name is needed").max(80)),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/, "pick a colour like #6b7a90").optional(),
  // The address replies leave from: its domain must be verified in the mail service.
  supportAddress: z.union([z.literal("").transform(() => null), emailAddress]).optional(),
  senderName: z
    .string()
    .transform(oneLine)
    .pipe(z.string().max(80))
    .transform((value) => value || null)
    .optional(),
});

export type ProductInput = z.input<typeof productInput>;

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "product";

export const productsOf = (db: Database, workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(product).orderBy(asc(product.name)));

export type Product = Awaited<ReturnType<typeof productsOf>>[number];

/** A product's address and sender name are what leaves in the company's name: an owner or an admin decides them. */
async function refused(db: Database, workspaceId: string, actorId: string): Promise<string | null> {
  return managesSettings(await roleIn(db, workspaceId, actorId)) ? null : NOT_A_MANAGER_OF_SETTINGS;
}

export async function createProduct(db: Database, workspaceId: string, actorId: string, values: ProductInput): Promise<Tried> {
  const refusal = await refused(db, workspaceId, actorId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = productInput.safeParse(values);
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };
  const slug = slugOf(parsed.data.name);
  return withWorkspace(db, workspaceId, async (tx) => {
    if ((await tx.select({ id: product.id }).from(product).where(eq(product.slug, slug))).length > 0) return { ok: false, error: "A product with this name already exists." };
    await tx.insert(product).values({ ...parsed.data, slug, publicKey: `pk_${randomToken(24)}` });
    return { ok: true, said: `${parsed.data.name} added.` };
  });
}

/** Its slug stays when it's renamed: apps name a product by it. */
export async function updateProduct(db: Database, workspaceId: string, actorId: string, id: string, values: ProductInput): Promise<Tried> {
  const refusal = await refused(db, workspaceId, actorId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = productInput.safeParse(values);
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };
  const changed = await withWorkspace(db, workspaceId, (tx) => tx.update(product).set(parsed.data).where(eq(product.id, id)).returning({ id: product.id }));
  return changed.length > 0 ? { ok: true, said: "Saved." } : { ok: false, error: "This product no longer exists." };
}

/** Its tickets stay, without a product; a widget still using its key stops opening any. */
export async function deleteProduct(db: Database, workspaceId: string, actorId: string, id: string): Promise<boolean> {
  if (await refused(db, workspaceId, actorId)) return false;
  return (await withWorkspace(db, workspaceId, (tx) => tx.delete(product).where(eq(product.id, id)).returning({ id: product.id }))).length > 0;
}

/** A leaked or abused public key is replaced, and the old snippet stops working. */
export async function renewPublicKey(db: Database, workspaceId: string, actorId: string, id: string): Promise<boolean> {
  if (await refused(db, workspaceId, actorId)) return false;
  const changed = await withWorkspace(db, workspaceId, (tx) => tx.update(product).set({ publicKey: `pk_${randomToken(24)}` }).where(and(eq(product.id, id), ne(product.publicKey, ""))).returning({ id: product.id }));
  return changed.length > 0;
}

/** The product a public key opens tickets for. Trusted path: the key comes before any workspace is known. */
export async function productOfPublicKey(db: Database, publicKey: string) {
  const [row] = await db.select({ id: product.id, workspaceId: product.workspaceId }).from(product).where(eq(product.publicKey, publicKey));
  return row ?? null;
}
