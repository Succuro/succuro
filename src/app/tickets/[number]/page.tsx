import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { categoriesOf } from "@/application/categories";
import { productsOf } from "@/application/products";
import { savedRepliesOf } from "@/application/saved-replies";
import { teamOf } from "@/application/team";
import { ticketForTeam } from "@/application/ticket-queries";
import { Loading, Shell } from "@/components/shell";
import { ActionForm } from "@/components/try-button";
import { Badge, Card, FIELD } from "@/components/ui";
import { PRIORITY_NAMES, STATUS_NAMES } from "@/domain/tickets";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";
import { noteAction, replyAction } from "./actions";
import { Conversation } from "./conversation";
import { ReplyBox } from "./reply-box";
import { SidePanel } from "./side-panel";

export const metadata: Metadata = { title: "Ticket" };

async function Content({ params }: Pick<PageProps<"/tickets/[number]">, "params">) {
  const { number: given } = await params;
  const number = Number(given);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) notFound();
  const seat = await currentSeat();
  const services = appServices();
  const ticket = await ticketForTeam(services.db, seat.workspaceId, number);
  if (!ticket) notFound();
  const [savedReplies, products, categories, people] = await Promise.all([savedRepliesOf(services.db, seat.workspaceId), productsOf(services.db, seat.workspaceId), categoriesOf(services.db, seat.workspaceId), teamOf(services.db, seat.workspaceId)]);
  const team = people.map(({ userId, name }) => ({ id: userId, name }));
  return (
    <>
      <p className="text-sm">
        <Link href="/tickets" className="text-muted-foreground hover:text-foreground">
          Inbox
        </Link>
      </p>
      <div className="mt-2 mb-6 flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-[-0.03em]">
          <span className="font-mono text-base text-muted-foreground">#{number}</span> {ticket.ticket.subject}
        </h1>
        <Badge tone={ticket.ticket.status === "open" ? "calm" : "plain"}>{STATUS_NAMES[ticket.ticket.status]}</Badge>
        <Badge>{PRIORITY_NAMES[ticket.ticket.priority]}</Badge>
        {ticket.productName && <Badge>{ticket.productName}</Badge>}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          <Conversation ticket={ticket} />
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-medium">Reply to {ticket.contact.email}</h2>
            <ReplyBox action={replyAction.bind(null, number)} savedReplies={savedReplies} />
          </Card>
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-medium">Internal note</h2>
            <ActionForm action={noteAction.bind(null, number)} submit="Add the note" busy="…" quiet>
              <textarea name="body" required rows={3} aria-label="Internal note" placeholder="For the team: never sent, never shown to the requester" className={FIELD} />
            </ActionForm>
          </Card>
        </div>
        <SidePanel ticket={ticket} team={team} products={products} categories={categories} services={services} />
      </div>
    </>
  );
}

/** One ticket: the conversation, the reply box and the note, and everything known beside them. */
export default function TicketPage({ params }: PageProps<"/tickets/[number]">) {
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Content params={params} />
      </Suspense>
    </Shell>
  );
}
