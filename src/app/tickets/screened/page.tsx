import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { productsOf, type Product } from "@/application/products";
import { screenedMailOf, type ScreenedMail, type ScreenedTab } from "@/application/screened-mail";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ActionForm, TryButton } from "@/components/try-button";
import { Badge, INLINE_FIELD, QuietButton } from "@/components/ui";
import { when } from "@/components/when";
import { SCREEN_REASON_NAMES } from "@/domain/mail-routing";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { SelectAll } from "../select-all";
import { dismissOneAction, dismissSelectedAction, promoteAction } from "./actions";

export const metadata: Metadata = { title: "Screened" };

const BULK_FORM = "dismiss-selected";

const TABS: { tab: ScreenedTab; label: string; meaning: string }[] = [
  { tab: "waiting", label: "Waiting", meaning: "Waiting for a decision" },
  { tab: "dismissed", label: "Dismissed", meaning: "Set aside: each can still become a ticket" },
];

const hrefOf = (tab: ScreenedTab, page = 1) => `/tickets/screened?${new URLSearchParams({ tab, ...(page > 1 ? { page: String(page) } : {}) })}`;

function Tabs({ current, counts }: { current: ScreenedTab; counts: Record<ScreenedTab, number> }) {
  return (
    <nav aria-label="Screened mail" className="flex flex-wrap gap-1">
      {TABS.map(({ tab, label, meaning }) => (
        <Link key={tab} href={hrefOf(tab)} title={meaning} aria-current={tab === current ? "page" : undefined} className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${tab === current ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          {label} <span className="font-mono text-xs">{counts[tab]}</span>
        </Link>
      ))}
    </nav>
  );
}

/** A stranger's words, as plain text: nothing in them is a link, a picture or an instruction. */
function WhatItSaid({ mail }: { mail: ScreenedMail }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm text-link">Read it</summary>
      <p className="mt-2 text-xs text-muted-foreground">Written by a stranger and not checked. Nothing in it is a link, and nothing has been answered.</p>
      {mail.senderSuspect && <p className="mt-1 text-xs text-alert">Its sender checks failed: the From line may be anyone.</p>}
      <pre className="mt-2 max-h-96 overflow-auto rounded-lg border bg-surface p-3 text-sm break-words whitespace-pre-wrap">{mail.body}</pre>
      {mail.attachments.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Not kept, only noted: {mail.attachments.map(({ filename }) => filename).join(", ")}</p>}
    </details>
  );
}

function MailRow({ mail, products }: { mail: ScreenedMail; products: Product[] }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      {mail.state === "waiting" && <input type="checkbox" name="mail" value={mail.id} form={BULK_FORM} aria-label={`Select the mail from ${mail.fromAddress}`} className="mt-1" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 font-medium break-words">{mail.subject}</span>
          <Badge>{SCREEN_REASON_NAMES[mail.reason]}</Badge>
        </div>
        <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span className="break-all">{mail.fromName ? `${mail.fromName} <${mail.fromAddress}>` : mail.fromAddress}</span>
          <span className="break-all">to {mail.addressedTo.join(", ") || "nobody it names"}</span>
          <span>{when(mail.receivedAt)}</span>
        </p>
        <WhatItSaid mail={mail} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ActionForm action={promoteAction.bind(null, mail.id)} submit="Open a ticket" busy="…" quiet className="flex flex-wrap items-center gap-2">
            <select name="product" defaultValue={mail.productId ?? ""} aria-label="The ticket’s product" className={INLINE_FIELD}>
              <option value="">No product</option>
              {products.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </ActionForm>
          {mail.state === "waiting" && <TryButton action={dismissOneAction.bind(null, mail.id)} label="Dismiss" busy="…" />}
        </div>
      </div>
    </li>
  );
}

const pageIn = (value: unknown) => {
  const page = typeof value === "string" ? Number(value) : 1;
  return Number.isInteger(page) && page > 0 ? page : 1;
};

async function Content({ searchParams }: Pick<PageProps<"/tickets/screened">, "searchParams">) {
  const query = await searchParams;
  const seat = await currentSeat();
  const tab: ScreenedTab = query.tab === "dismissed" ? "dismissed" : "waiting";
  const page = pageIn(query.page);
  const [{ mails, counts, hasMore }, products] = await Promise.all([screenedMailOf(db(), seat.workspaceId, tab, page), productsOf(db(), seat.workspaceId)]);
  return (
    <div className="space-y-4">
      <Tabs current={tab} counts={counts} />
      <div className="rounded-2xl border bg-card">
        {tab === "waiting" && mails.length > 0 && (
          <ActionForm id={BULK_FORM} action={dismissSelectedAction} className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <SelectAll name="mail" />
            <QuietButton type="submit">Dismiss selected</QuietButton>
          </ActionForm>
        )}
        {mails.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">Nothing here.</p>
        ) : (
          <ul className="divide-y">
            {mails.map((mail) => (
              <MailRow key={mail.id} mail={mail} products={products} />
            ))}
          </ul>
        )}
      </div>
      {(page > 1 || hasMore) && (
        <div className="flex gap-4 text-sm">
          {page > 1 && (
            <Link href={hrefOf(tab, page - 1)} className="text-link hover:underline">
              Newer
            </Link>
          )}
          {hasMore && (
            <Link href={hrefOf(tab, page + 1)} className="text-link hover:underline">
              Older
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/** New mail that didn't open a ticket, kept whole until someone decides. Nobody was told, and nobody was answered. */
export default function ScreenedPage({ searchParams }: PageProps<"/tickets/screened">) {
  return (
    <Shell>
      <PageHeading title="Screened">New mail that didn’t open a ticket: sent to no product’s address, flagged, failing its sender checks, or from a machine. Nobody was told and nobody was answered. Open a ticket from one, or dismiss it.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
