import type { Metadata } from "next";
import { Suspense } from "react";
import { categoriesOf } from "@/application/categories";
import { productsOf } from "@/application/products";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ActionForm } from "@/components/try-button";
import { Card, FIELD, Labelled } from "@/components/ui";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { newTicketAction } from "../actions";

export const metadata: Metadata = { title: "New ticket" };

async function Form() {
  const seat = await currentSeat();
  const [products, categories] = await Promise.all([productsOf(db(), seat.workspaceId), categoriesOf(db(), seat.workspaceId)]);
  return (
    <Card className="max-w-2xl">
      <ActionForm action={newTicketAction} submit="Open the ticket" busy="…">
        <div className="grid gap-3 sm:grid-cols-2">
          <Labelled label="Their email">
            <input name="email" type="email" required className={FIELD} />
          </Labelled>
          <Labelled label="Their name">
            <input name="name" maxLength={120} className={FIELD} />
          </Labelled>
          <Labelled label="Product">
            <select name="product" className={FIELD}>
              <option value="">None</option>
              {products.map((product) => (
                <option key={product.id} value={product.slug}>
                  {product.name}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Category">
            <select name="category" className={FIELD}>
              <option value="">None</option>
              {categories.map((category) => (
                <option key={category.id} value={category.name}>
                  {category.name}
                </option>
              ))}
            </select>
          </Labelled>
        </div>
        <Labelled label="Subject">
          <input name="subject" required maxLength={200} className={FIELD} />
        </Labelled>
        <Labelled label="What they asked">
          <textarea name="message" required rows={6} className={FIELD} />
        </Labelled>
      </ActionForm>
    </Card>
  );
}

/** For a request that came in some other way: a call, a chat. Nothing is sent to them. */
export default function NewTicketPage() {
  return (
    <Shell section="inbox">
      <PageHeading title="New ticket">For a request that came in some other way. Nothing is sent to them.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Form />
      </Suspense>
    </Shell>
  );
}
