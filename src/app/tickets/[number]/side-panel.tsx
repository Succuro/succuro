import Link from "next/link";
import { requesterUrlOf } from "@/application/requester-links";
import type { Services } from "@/application/services";
import type { TeamTicket } from "@/application/ticket-queries";
import { ActionForm, ConfirmButton, CopyButton } from "@/components/try-button";
import { Badge, Card, FIELD, Labelled } from "@/components/ui";
import { CHANNEL_NAMES, PRIORITY_NAMES, STATUS_NAMES, TICKET_PRIORITIES, TICKET_STATUSES } from "@/domain/tickets";
import { endLinksAction, updateTicketAction } from "./actions";

type Named = { id: string; name: string };

/** Status, priority, who holds it, how it's sorted. */
function Controls({ ticket, team, products, categories }: { ticket: TeamTicket; team: Named[]; products: Named[]; categories: Named[] }) {
  const { number, status, priority, assigneeId, productId, categoryId, tags } = ticket.ticket;
  return (
    <Card className="p-4">
      <ActionForm action={updateTicketAction.bind(null, number)} submit="Save" busy="…" quiet>
        <Labelled label="Status">
          <select name="status" defaultValue={status} className={FIELD}>
            {TICKET_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_NAMES[value]}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled label="Priority">
          <select name="priority" defaultValue={priority} className={FIELD}>
            {TICKET_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {PRIORITY_NAMES[value]}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled label="Assignee">
          <select name="assignee" defaultValue={assigneeId ?? ""} className={FIELD}>
            <option value="">Unassigned</option>
            {team.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled label="Product" hint="Replies leave from its address.">
          <select name="product" defaultValue={productId ?? ""} className={FIELD}>
            <option value="">None</option>
            {products.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled label="Category">
          <select name="category" defaultValue={categoryId ?? ""} className={FIELD}>
            <option value="">None</option>
            {categories.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled label="Tags" hint="Separated by commas.">
          <input name="tags" defaultValue={tags.join(", ")} className={FIELD} />
        </Labelled>
      </ActionForm>
    </Card>
  );
}

function Requester({ ticket, requesterUrl }: { ticket: TeamTicket; requesterUrl: string }) {
  const { contact, others } = ticket;
  return (
    <Card className="p-4">
      <h2 className="text-sm font-medium">Requester</h2>
      <p className="mt-2 text-sm">{contact.name ?? contact.email}</p>
      {contact.name && <p className="text-xs break-all text-muted-foreground">{contact.email}</p>}
      {contact.externalId && <p className="mt-1 font-mono text-xs text-muted-foreground">Their id in your app: {contact.externalId}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <CopyButton text={requesterUrl} label="Copy their link" />
        <ConfirmButton action={endLinksAction.bind(null, ticket.ticket.number)} label="End their links" confirm="Confirm: links already sent stop working" />
      </div>
      <h3 className="mt-4 text-sm font-medium">Their other tickets</h3>
      {others.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">None.</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {others.map((other) => (
            <li key={other.number} className="flex items-center gap-2">
              <Link href={`/tickets/${other.number}`} className="min-w-0 truncate text-link hover:underline">
                #{other.number} {other.subject}
              </Link>
              <Badge>{STATUS_NAMES[other.status]}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Only a web address becomes a link: this came from outside, and a javascript: address must stay text. */
const isWebAddress = (url: string | null): url is string => Boolean(url && /^https?:\/\//i.test(url));

function About({ ticket }: { ticket: TeamTicket["ticket"] }) {
  const { aboutType, aboutId, aboutTitle, aboutUrl, context, channel } = ticket;
  const hasAbout = aboutType || aboutId || aboutTitle || aboutUrl;
  return (
    <Card className="p-4">
      <h2 className="text-sm font-medium">Came in by</h2>
      <p className="mt-1 text-sm text-muted-foreground">{CHANNEL_NAMES[channel]}</p>
      {hasAbout && (
        <>
          <h2 className="mt-4 text-sm font-medium">About</h2>
          <p className="mt-1 text-sm">{aboutTitle ?? aboutId}</p>
          <p className="text-xs text-muted-foreground">{[aboutType, aboutTitle ? aboutId : null].filter(Boolean).join(" · ")}</p>
          {isWebAddress(aboutUrl) && (
            <a href={aboutUrl} target="_blank" rel="noreferrer noopener" className="mt-1 block text-xs break-all text-link hover:underline">
              {aboutUrl}
            </a>
          )}
        </>
      )}
      {context && (
        <>
          <h2 className="mt-4 text-sm font-medium">Context</h2>
          <pre className="mt-1 overflow-x-auto rounded-lg border bg-surface p-2 font-mono text-xs">{JSON.stringify(context, null, 2)}</pre>
        </>
      )}
    </Card>
  );
}

/** Everything beside the conversation: the controls, who wrote in, what it's about. */
export function SidePanel({ ticket, team, products, categories, services }: { ticket: TeamTicket; team: Named[]; products: Named[]; categories: Named[]; services: Pick<Services, "settings" | "now"> }) {
  return (
    <aside className="space-y-4">
      <Controls ticket={ticket} team={team} products={products} categories={categories} />
      <Requester ticket={ticket} requesterUrl={requesterUrlOf(services, ticket.ticket)} />
      <About ticket={ticket.ticket} />
    </aside>
  );
}
