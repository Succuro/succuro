"use server";

import { revalidatePath } from "next/cache";
import { addNote } from "@/application/conversation";
import { discardDraft, replyNow, saveDraft, sendReply } from "@/application/replies";
import { endRequesterLinks, updateTicket } from "@/application/tickets";
import { TICKET_PRIORITIES, TICKET_STATUSES, type TicketPriority, type TicketStatus } from "@/domain/tickets";
import type { Tried } from "@/domain/tried";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

const asMember = (userId: string) => ({ userId, writtenBy: "member" as const });

function refresh(number: number) {
  revalidatePath(`/tickets/${number}`);
  revalidatePath("/tickets");
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

/** One box, three buttons: send, send and settle, or keep it as a draft. */
export async function replyAction(number: number, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const services = appServices();
  const intent = text(form, "intent");
  const body = text(form, "body");
  const actor = asMember(seat.userId);
  const done: Tried =
    intent === "draft"
      ? await saveDraft(services.db, seat.workspaceId, number, body, actor).then((drafted) => (drafted.ok ? { ok: true, said: "Draft saved." } : drafted))
      : await replyNow(services, seat.workspaceId, number, body, actor, intent === "resolve" ? "resolved" : undefined);
  refresh(number);
  return done;
}

export async function noteAction(number: number, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const added = await addNote(appServices(), seat.workspaceId, number, text(form, "body"), asMember(seat.userId));
  refresh(number);
  return added.ok ? { ok: true, said: "Note added." } : added;
}

/** A draft or a failed reply, sent as it reads in its box now. */
export async function sendDraftAction(number: number, messageId: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const sent = await sendReply(appServices(), seat.workspaceId, messageId, asMember(seat.userId), { body: text(form, "body") });
  refresh(number);
  return sent;
}

export async function discardDraftAction(number: number, messageId: string): Promise<void> {
  const seat = await currentSeat();
  await discardDraft(appServices().db, seat.workspaceId, messageId);
  refresh(number);
}

/** A choice left empty takes the value off, except status and priority, which always have one. */
export async function updateTicketAction(number: number, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const status = text(form, "status");
  const priority = text(form, "priority");
  const updated = await updateTicket(
    appServices(),
    seat.workspaceId,
    number,
    {
      status: (TICKET_STATUSES as readonly string[]).includes(status) ? (status as TicketStatus) : undefined,
      priority: (TICKET_PRIORITIES as readonly string[]).includes(priority) ? (priority as TicketPriority) : undefined,
      assigneeId: text(form, "assignee") || null,
      categoryId: text(form, "category") || null,
      productId: text(form, "product") || null,
      tags: text(form, "tags").split(","),
    },
    asMember(seat.userId),
  );
  refresh(number);
  return updated.ok ? { ok: true, said: "Saved." } : updated;
}

export async function endLinksAction(number: number): Promise<void> {
  const seat = await currentSeat();
  await endRequesterLinks(appServices().db, seat.workspaceId, number);
  refresh(number);
}
