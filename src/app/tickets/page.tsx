import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { Suspense } from "react";
import { categoriesOf } from "@/application/categories";
import { productsOf } from "@/application/products";
import { teamOf } from "@/application/team";
import { listTickets, tagsInUse, type InboxTicket } from "@/application/ticket-queries";
import { Loading, Shell } from "@/components/shell";
import { ActionForm } from "@/components/try-button";
import { Badge, INLINE_FIELD, QuietButton } from "@/components/ui";
import { when } from "@/components/when";
import { PRIORITY_NAMES, STATUS_MEANINGS, STATUS_NAMES, TICKET_PRIORITIES, TICKET_STATUSES, type TicketStatus } from "@/domain/tickets";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { bulkAction } from "./actions";
import { filtersOf, inboxHref, pageOf, statusTab, type InboxQuery } from "./query";
import { SelectAll } from "./select-all";

export const metadata: Metadata = { title: "Inbox" };

function StatusTabs({ query, counts }: { query: InboxQuery; counts: Record<TicketStatus, number> }) {
  const tab = statusTab(query);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const tabs = [...TICKET_STATUSES.map((status) => ({ key: status as string, label: STATUS_NAMES[status], count: counts[status], title: STATUS_MEANINGS[status] })), { key: "all", label: "All", count: total, title: "Every status" }];
  return (
    <nav aria-label="Status" className="flex flex-wrap gap-1">
      {tabs.map(({ key, label, count, title }) => (
        <Link key={key} href={inboxHref(query, { status: key, page: undefined })} title={title} aria-current={tab === key ? "page" : undefined} className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${tab === key ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          {label} <span className="font-mono text-xs">{count}</span>
        </Link>
      ))}
    </nav>
  );
}

type Named = { id: string; name: string };

function Choice({ name, label, value, options }: { name: string; label: string; value?: string; options: { value: string; label: string }[] }) {
  return (
    <select name={name} defaultValue={value ?? ""} aria-label={label} className={INLINE_FIELD}>
      <option value="">{label}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

const asOptions = (rows: Named[]) => rows.map(({ id, name }) => ({ value: id, label: name }));
const one = (query: InboxQuery, name: string) => (typeof query[name] === "string" ? (query[name] as string) : undefined);

function Filters({ query, products, categories, team, tags }: { query: InboxQuery; products: Named[]; categories: Named[]; team: Named[]; tags: string[] }) {
  return (
    <Form action="/tickets" className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="status" value={statusTab(query)} />
      <input name="q" defaultValue={one(query, "q")} placeholder="Search" aria-label="Search" className={`${INLINE_FIELD} min-w-48 flex-1`} />
      <Choice name="product" label="Any product" value={one(query, "product")} options={asOptions(products)} />
      <Choice name="assignee" label="Anyone" value={one(query, "assignee")} options={[{ value: "me", label: "Mine" }, { value: "none", label: "Unassigned" }, ...asOptions(team)]} />
      <Choice name="priority" label="Any priority" value={one(query, "priority")} options={TICKET_PRIORITIES.map((priority) => ({ value: priority, label: PRIORITY_NAMES[priority] }))} />
      <Choice name="category" label="Any category" value={one(query, "category")} options={asOptions(categories)} />
      <Choice name="tag" label="Any tag" value={one(query, "tag")} options={tags.map((tag) => ({ value: tag, label: tag }))} />
      <QuietButton type="submit">Filter</QuietButton>
    </Form>
  );
}

function TicketRow({ ticket, assignee }: { ticket: InboxTicket; assignee?: string }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <input type="checkbox" name="ticket" value={ticket.id} aria-label={`Select ticket ${ticket.number}`} className="mt-1" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link href={`/tickets/${ticket.number}`} className="min-w-0 font-medium hover:underline">
            <span className="font-mono text-xs text-muted-foreground">#{ticket.number}</span> {ticket.subject}
          </Link>
          <Badge tone={ticket.status === "open" ? "calm" : "plain"}>{STATUS_NAMES[ticket.status]}</Badge>
          {(ticket.priority === "high" || ticket.priority === "urgent") && <Badge tone="alert">{PRIORITY_NAMES[ticket.priority]}</Badge>}
          {ticket.categoryName && <Badge>{ticket.categoryName}</Badge>}
          {ticket.tags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {ticket.productName && (
            <span className="flex items-center gap-1">
              <span aria-hidden className="inline-block size-2 rounded-full" style={{ backgroundColor: ticket.productColour ?? undefined }} />
              {ticket.productName}
            </span>
          )}
          <span>{ticket.contactName ? `${ticket.contactName} <${ticket.contactEmail}>` : ticket.contactEmail}</span>
          <span>{assignee ? `Assigned to ${assignee}` : "Unassigned"}</span>
          <span>{when(ticket.lastMessageAt)}</span>
        </p>
      </div>
    </li>
  );
}

/** What the selected tickets become. Each field left alone changes nothing. */
function BulkBar({ team }: { team: Named[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
      <SelectAll />
      <Choice name="status" label="Status: no change" options={TICKET_STATUSES.map((status) => ({ value: status, label: STATUS_NAMES[status] }))} />
      <Choice name="assignee" label="Assignee: no change" options={[{ value: "none", label: "Unassigned" }, ...asOptions(team)]} />
      <Choice name="priority" label="Priority: no change" options={TICKET_PRIORITIES.map((priority) => ({ value: priority, label: PRIORITY_NAMES[priority] }))} />
      <input name="tag" placeholder="Add a tag" aria-label="Add a tag" maxLength={40} className={`${INLINE_FIELD} w-32`} />
      <QuietButton type="submit">Apply to selected</QuietButton>
    </div>
  );
}

/** First steps, for a workspace with nothing in it yet. */
function Empty({ anyTicket }: { anyTicket: boolean }) {
  if (anyTicket) return <p className="px-4 py-10 text-center text-sm text-muted-foreground">Nothing here.</p>;
  return (
    <div className="px-4 py-10 text-center text-sm text-muted-foreground">
      <p>No tickets yet.</p>
      <p className="mt-2">
        <Link href="/settings/products" className="text-link hover:underline">
          Add a product
        </Link>
        ,{" "}
        <Link href="/connections/resend" className="text-link hover:underline">
          connect your mail
        </Link>
        , or{" "}
        <Link href="/keys" className="text-link hover:underline">
          make an API key
        </Link>{" "}
        for your apps.
      </p>
    </div>
  );
}

async function Inbox({ searchParams }: Pick<PageProps<"/tickets">, "searchParams">) {
  const query = await searchParams;
  const seat = await currentSeat();
  const page = pageOf(query);
  const [{ tickets, counts, hasMore }, products, categories, people, tags] = await Promise.all([listTickets(db(), seat.workspaceId, filtersOf(query, seat.userId), page), productsOf(db(), seat.workspaceId), categoriesOf(db(), seat.workspaceId), teamOf(db(), seat.workspaceId), tagsInUse(db(), seat.workspaceId)]);
  const team = people.map(({ userId, name }) => ({ id: userId, name }));
  const nameOf = (userId: string | null) => people.find((person) => person.userId === userId)?.name;
  const anyTicket = Object.values(counts).some((count) => count > 0) || tags.length > 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusTabs query={query} counts={counts} />
        <div className="flex items-center gap-3 text-sm">
          <Link href={inboxHref(query, { assignee: "me", page: undefined })} className="text-muted-foreground hover:text-foreground">
            Mine
          </Link>
          <Link href={inboxHref(query, { assignee: "none", page: undefined })} className="text-muted-foreground hover:text-foreground">
            Unassigned
          </Link>
          <Link href="/tickets/new" className="rounded-lg border px-3 py-1.5 font-medium transition-colors hover:bg-accent">
            New ticket
          </Link>
        </div>
      </div>
      <Filters query={query} products={asOptions(products).map(({ value, label }) => ({ id: value, name: label }))} categories={categories} team={team} tags={tags} />
      <ActionForm action={bulkAction} className="rounded-2xl border bg-card">
        <BulkBar team={team} />
        {tickets.length === 0 ? (
          <Empty anyTicket={anyTicket} />
        ) : (
          <ul className="divide-y">
            {tickets.map((ticket) => (
              <TicketRow key={ticket.id} ticket={ticket} assignee={nameOf(ticket.assigneeId)} />
            ))}
          </ul>
        )}
      </ActionForm>
      {(page > 1 || hasMore) && (
        <div className="flex gap-4 text-sm">
          {page > 1 && (
            <Link href={inboxHref(query, { page: String(page - 1) })} className="text-link hover:underline">
              Newer
            </Link>
          )}
          {hasMore && (
            <Link href={inboxHref(query, { page: String(page + 1) })} className="text-link hover:underline">
              Older
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/** Every ticket from every product, by what waits for whom. */
export default function InboxPage({ searchParams }: PageProps<"/tickets">) {
  return (
    <Shell section="inbox">
      <Suspense fallback={<Loading />}>
        <Inbox searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
