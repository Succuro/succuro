import type { Metadata } from "next";
import { Suspense } from "react";
import { categoriesOf } from "@/application/categories";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { ActionForm, ConfirmButton } from "@/components/try-button";
import { Card, FIELD } from "@/components/ui";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { addCategoryAction, removeCategoryAction } from "./actions";

export const metadata: Metadata = { title: "Categories" };

async function Content() {
  const seat = await currentSeat();
  const categories = await categoriesOf(db(), seat.workspaceId);
  return (
    <div className="max-w-3xl space-y-4">
      {categories.length > 0 && (
        <ul className="divide-y rounded-2xl border bg-card">
          {categories.map((category) => (
            <li key={category.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              {category.name}
              <ConfirmButton action={removeCategoryAction.bind(null, category.id)} label="Remove" confirm="Confirm: its tickets stay, without a category" />
            </li>
          ))}
        </ul>
      )}
      <Card>
        <ActionForm action={addCategoryAction} submit="Add the category" busy="…" quiet>
          <input name="name" required maxLength={60} placeholder="Refunds" aria-label="Category name" className={FIELD} />
        </ActionForm>
      </Card>
    </div>
  );
}

/** How this workspace sorts its tickets. */
export default function CategoriesPage() {
  return (
    <Shell>
      <PageHeading title="Categories">How this workspace sorts its tickets.</PageHeading>
      <SettingsNav />
      <Suspense fallback={<Loading />}>
        <Content />
      </Suspense>
    </Shell>
  );
}
