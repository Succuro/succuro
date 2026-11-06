import type { TeamMessage, TeamTicket } from "@/application/ticket-queries";
import { ActionForm, ConfirmButton } from "@/components/try-button";
import { Badge, FIELD, PrimaryButton } from "@/components/ui";
import { when } from "@/components/when";
import { discardDraftAction, sendDraftAction } from "./actions";

const DELIVERY_WORDS: Record<string, string> = { draft: "Draft: not sent", sending: "Sending…", sent: "Sent", delivered: "Delivered", delayed: "Delayed", bounced: "Bounced", complained: "Marked as spam", failed: "Not sent" };

const size = (bytes: number | null) => (bytes === null ? "" : ` (${Math.max(1, Math.round(bytes / 1024))} KB)`);

function Attachments({ message }: { message: TeamMessage }) {
  return message.attachments.map((attachment) => (
    <p key={attachment.filename} className="mt-2 text-xs text-alert">
      Attachment not kept: {attachment.filename}
      {size(attachment.size)}. It arrived, but this version doesn’t store attachments.
    </p>
  ));
}

function Header({ message, who }: { message: TeamMessage; who: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{who}</span>
      <span>{when(message.createdAt)}</span>
      {message.writtenBy === "assistant" && <Badge>Written by an assistant</Badge>}
      {message.deliveryState && <Badge tone={message.deliveryError ? "alert" : "plain"}>{DELIVERY_WORDS[message.deliveryState]}</Badge>}
      {message.fromAddress && <Badge tone="alert">From another address: {message.fromAddress}</Badge>}
      {message.senderSuspect && <Badge tone="alert">Sender not verified: its address may be forged</Badge>}
    </div>
  );
}

/** A draft or a failed reply: its words can change, and it's sent from here or thrown away. */
function Waiting({ number, message }: { number: number; message: TeamMessage }) {
  return (
    <div className="mt-3">
      <ActionForm action={sendDraftAction.bind(null, number, message.id)}>
        <textarea name="body" required rows={5} defaultValue={message.body} aria-label="Reply to send" className={FIELD} />
        <div>
          <PrimaryButton type="submit">{message.deliveryState === "failed" ? "Send again" : "Send this reply"}</PrimaryButton>
        </div>
      </ActionForm>
      {message.deliveryState === "draft" && (
        <div className="mt-2 flex flex-wrap gap-2">
          <ConfirmButton action={discardDraftAction.bind(null, number, message.id)} label="Discard the draft" confirm="Confirm: throw it away" />
        </div>
      )}
    </div>
  );
}

function Entry({ number, message, requester }: { number: number; message: TeamMessage; requester: string }) {
  if (message.kind === "system") return <li className="px-1 text-xs text-muted-foreground">{`${when(message.createdAt)}: ${message.body}`}</li>;
  const waiting = message.kind === "agent" && (message.deliveryState === "draft" || message.deliveryState === "failed");
  const styles = { customer: "bg-card", agent: "border-calm/30 bg-calm/5", note: "border-note-border bg-note" }[message.kind];
  const who = { customer: requester, agent: message.authorName ?? "The team", note: `Internal note, ${message.authorName ?? "the team"}` }[message.kind];
  return (
    <li className={`rounded-2xl border p-4 ${styles}`} data-kind={message.kind}>
      <Header message={message} who={who} />
      {message.deliveryError && <p className="mt-2 text-sm text-alert">{message.deliveryError}</p>}
      {waiting ? <Waiting number={number} message={message} /> : <p className="mt-2 text-sm whitespace-pre-wrap">{message.body}</p>}
      <Attachments message={message} />
    </li>
  );
}

/** The whole conversation, as the team sees it: what the requester sees is a smaller list, in application/requester.ts. */
export function Conversation({ ticket }: { ticket: TeamTicket }) {
  const requester = ticket.contact.name ?? ticket.contact.email;
  return (
    <ol className="space-y-3">
      {ticket.messages.map((message) => (
        <Entry key={message.id} number={ticket.ticket.number} message={message} requester={requester} />
      ))}
    </ol>
  );
}
