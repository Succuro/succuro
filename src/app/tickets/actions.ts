"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createTicket, updateTickets, type TicketChanges } from "@/application/tickets";
import { firstProblem, newTicketInput } from "@/domain/ticket-input";
import { TICKET_PRIORITIES, TICKET_STATUSES, type TicketPriority, type TicketStatus } from "@/domain/tickets";
import type { Tried } from "@/domain/tried";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

const INBOX = "/tickets";

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** What a bulk bar's fields ask for; a field left on "no change" stays out. */
function bulkChangesOf(form: FormData): TicketChanges {
  const status = text(form, "status");
  const priority = text(form, "priority");
  const assignee = text(form, "assignee");
  const tag = text(form, "tag");
  return {
    ...((TICKET_STATUSES as readonly string[]).includes(status) ? { status: status as TicketStatus } : {}),
    ...((TICKET_PRIORITIES as readonly string[]).includes(priority) ? { priority: priority as TicketPriority } : {}),
    ...(assignee ? { assigneeId: assignee === "none" ? null : assignee } : {}),
    ...(tag ? { addTags: [tag] } : {}),
  };
}

export async function bulkAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const changes = bulkChangesOf(form);
  if (Object.keys(changes).length === 0) return { ok: false, error: "Choose what to change." };
  const updated = await updateTickets(appServices(), seat.workspaceId, form.getAll("ticket").map(String), changes, { userId: seat.userId, writtenBy: "member" });
  revalidatePath(INBOX);
  return updated.ok ? { ok: true, said: `${updated.count} ${updated.count === 1 ? "ticket" : "tickets"} changed.` } : updated;
}

/** A request that came in some other way, recorded by a member. */
export async function newTicketAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const parsed = newTicketInput.safeParse({ subject: text(form, "subject"), message: text(form, "message"), requester: { email: text(form, "email"), name: text(form, "name") }, product: text(form, "product") || undefined, category: text(form, "category") || undefined });
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };
  const created = await createTicket(appServices(), seat.workspaceId, parsed.data, { channel: "web", recordedBy: { userId: seat.userId, writtenBy: "member" } });
  if (!created.ok) return created;
  revalidatePath(INBOX);
  redirect(`/tickets/${created.number}`);
}
