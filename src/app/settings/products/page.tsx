import type { Metadata } from "next";
import { Suspense } from "react";
import { productsOf, type Product } from "@/application/products";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { ActionForm, ConfirmButton, CopyButton } from "@/components/try-button";
import { Card, Code, FIELD, Labelled } from "@/components/ui";
import { managesSettings } from "@/domain/team";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { env } from "@/infrastructure/env";
import { createProductAction, deleteProductAction, renewKeyAction, updateProductAction } from "./actions";

export const metadata: Metadata = { title: "Products" };

function ProductFields({ product }: { product?: Product }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Labelled label="Name">
        <input name="name" required maxLength={80} defaultValue={product?.name} placeholder="Acme App" className={FIELD} />
      </Labelled>
      <Labelled label="Colour">
        <input name="colour" type="color" defaultValue={product?.colour ?? "#6b7a90"} className="h-10 w-full rounded-lg border bg-surface p-1" />
      </Labelled>
      <Labelled label="Support address" hint="Where its mail arrives and replies leave from. Its domain must be verified in your mail service.">
        <input name="supportAddress" type="email" defaultValue={product?.supportAddress ?? ""} placeholder="support@acme.example" className={FIELD} />
      </Labelled>
      <Labelled label="Sender name" hint="How replies are signed. The product’s name when left empty.">
        <input name="senderName" maxLength={80} defaultValue={product?.senderName ?? ""} placeholder="Acme support" className={FIELD} />
      </Labelled>
    </div>
  );
}

/** The widget's snippet carries all it needs, so a page view asks the database nothing. */
const snippetOf = (product: Product, origin: string) => `<script src="${new URL("/widget.js", origin)}" data-key="${product.publicKey}" data-title="${product.name.replaceAll('"', "&quot;")}" data-colour="${product.colour}" defer></script>`;

const formUrl = (origin: string) => new URL("/api/public/tickets", origin).toString();

function ProductCard({ product, origin, mayChange }: { product: Product; origin: string; mayChange: boolean }) {
  const snippet = snippetOf(product, origin);
  return (
    <Card>
      <h2 className="flex items-center gap-2 font-semibold tracking-[-0.02em]">
        <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ backgroundColor: product.colour }} />
        {product.name}
      </h2>
      <p className="mt-1 font-mono text-xs text-muted-foreground">{product.slug}: apps name it by this.</p>
      {!product.supportAddress && <p className="mt-2 text-sm text-alert">No support address yet: replies on its tickets can’t be sent.</p>}
      {mayChange && (
        <div className="mt-4">
          <ActionForm action={updateProductAction.bind(null, product.id)} submit="Save" busy="…" quiet>
            <ProductFields product={product} />
          </ActionForm>
        </div>
      )}
      <div className="mt-5 border-t pt-5">
        <h3 className="text-sm font-medium">Widget</h3>
        <p className="mt-1 text-sm text-muted-foreground">Paste this before the end of a page’s body. Its key is public: it can only open tickets, and each visitor’s requests are limited.</p>
        <div className="mt-2">
          <Code>{snippet}</Code>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Or post your own form to <span className="font-mono text-xs">{formUrl(origin)}</span> with its key.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <CopyButton text={snippet} label="Copy the snippet" />
          {mayChange && <ConfirmButton action={renewKeyAction.bind(null, product.id)} label="New public key" confirm="Confirm: the old snippet stops working" />}
          {mayChange && <ConfirmButton action={deleteProductAction.bind(null, product.id)} label="Delete" confirm="Confirm: its tickets stay, without a product" />}
        </div>
      </div>
    </Card>
  );
}

async function Content() {
  const seat = await currentSeat();
  const products = await productsOf(db(), seat.workspaceId);
  const mayChange = managesSettings(seat.role);
  const origin = env().BETTER_AUTH_URL;
  return (
    <div className="max-w-3xl space-y-4">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} origin={origin} mayChange={mayChange} />
      ))}
      {products.length === 0 && <p className="text-sm text-muted-foreground">No product yet. Add the first one: its tickets, address and widget all start here.</p>}
      {mayChange ? (
        <Card>
          <h2 className="mb-4 font-semibold tracking-[-0.02em]">Add a product</h2>
          <ActionForm action={createProductAction} submit="Add the product" busy="…">
            <ProductFields />
          </ActionForm>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">Only owners and admins change products.</p>
      )}
    </div>
  );
}

/** Brands or projects inside a workspace, so one company runs several products from one inbox. */
export default function ProductsPage() {
  return (
    <Shell>
      <PageHeading title="Products">Each with its own address, sender name and widget, all in one inbox.</PageHeading>
      <SettingsNav />
      <Suspense fallback={<Loading />}>
        <Content />
      </Suspense>
    </Shell>
  );
}
