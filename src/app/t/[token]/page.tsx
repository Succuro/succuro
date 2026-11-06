import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { seeAsRequester, type RequesterMessage, type RequesterTicket } from "@/application/requester";
import { Loading, Standalone } from "@/components/shell";
import { ActionForm } from "@/components/try-button";
import { Card, FIELD } from "@/components/ui";
import { when } from "@/components/when";
import { STATUS_FOR_REQUESTER } from "@/domain/tickets";
import { appServices } from "@/infrastructure/services";
import { answerAction } from "./actions";

// The link is the key: it mustn't be indexed, or follow someone to the next site they visit.
export const metadata: Metadata = { title: "Your conversation", robots: { index: false }, referrer: "no-referrer" };

function Message({ message, team }: { message: RequesterMessage; team: string }) {
  const mine = message.from === "you";
  return (
    <li className={`rounded-2xl border p-4 ${mine ? "bg-card" : "border-calm/30 bg-calm/5"}`}>
      <p className="text-xs text-muted-foreground">
        {mine ? "You" : team} · {when(message.at)}
      </p>
      <p className="mt-2 text-sm whitespace-pre-wrap">{message.body}</p>
      {message.attachments.map((attachment) => (
        <p key={attachment.filename} className="mt-2 text-xs text-muted-foreground">
          We can’t receive attachments yet, so {attachment.filename} didn’t reach us. Please describe what it shows.
        </p>
      ))}
    </li>
  );
}

function Conversation({ ticket, token }: { ticket: RequesterTicket; token: string }) {
  const team = ticket.productName ?? "Support";
  return (
    <div className="mt-8 w-full max-w-2xl">
      <h1 className="text-2xl font-bold tracking-[-0.025em]">{ticket.subject}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {team} · Ticket #{ticket.number} · {STATUS_FOR_REQUESTER[ticket.status]}
      </p>
      <ul className="mt-6 space-y-3">
        {ticket.messages.map((message) => (
          <Message key={message.id} message={message} team={team} />
        ))}
      </ul>
      <Card className="mt-6">
        <ActionForm action={answerAction.bind(null, token)} submit="Send your answer" busy="Sending…">
          <textarea name="body" required rows={5} aria-label="Your answer" placeholder="Write your answer" className={FIELD} />
        </ActionForm>
      </Card>
    </div>
  );
}

async function Content({ params }: Pick<PageProps<"/t/[token]">, "params">) {
  await connection();
  const { token } = await params;
  const seen = await seeAsRequester(appServices(), token);
  if (seen.status === "open") return <Conversation ticket={seen.ticket} token={token} />;
  const words = seen.status === "expired" ? "This link has expired. Answer the last email you received, and the next one will carry a new link." : "This link isn’t valid.";
  return <p className="mt-8 max-w-sm text-center text-sm text-muted-foreground">{words}</p>;
}

/** Where someone who wrote in reads the conversation and answers, without an account. */
export default function RequesterPage({ params }: PageProps<"/t/[token]">) {
  return (
    <Standalone align="top">
      <Suspense fallback={<Loading />}>
        <Content params={params} />
      </Suspense>
    </Standalone>
  );
}
