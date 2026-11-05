import { eq, sql } from "drizzle-orm";
import { noticeMail, noticeRecipients, type NoticeKind, type NoticePreference } from "@/domain/notifications";
import type { Tried } from "@/domain/tried";
import type { Database } from "@/infrastructure/db/client";
import { message, notificationPreference, product } from "@/infrastructure/db/schema/support";
import { workspace } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { hasOwnMail, sendMachineMails } from "@/infrastructure/mail/own-mail";
import { countOneMore, HOUR_LIMITS } from "./rate-limit";
import type { Services } from "./services";
import { teamOf } from "./team";

/**
 * Telling the team that something came in, through the instance's own mail. Called once what it is
 * about has been committed, and it never throws: a ticket that arrived stays arrived whatever happens
 * to the mail about it. Nothing here runs on a schedule; a burst is capped rather than held back for
 * later, and the last mail before the cap says so.
 */

export interface TeamNotice {
  kind: NoticeKind;
  ticket: { id: string; number: number; subject: string; productId: string | null; assigneeId: string | null };
  writer: { contactId: string; email: string; userId?: string | null };
  /** What they wrote: a stranger's words, excerpted and stripped before they go in a mail. */
  words: string;
}

export type NoticeOutcome = { status: "no_mail" | "nobody" | "capped" } | { status: "sent"; to: string[] } | { status: "failed"; error: string };

/** Long enough for a healthy provider, short enough that a webhook or a form doesn't hang on a sick one. */
const SEND_TIMEOUT_MS = 5_000;

const FAILED = (why: string) => `The team couldn’t be mailed about this: ${why}`;

/** Counts this notice against each cap, the narrowest first, so one noisy ticket doesn't use up everyone's allowance. */
async function paceOf(tx: Database, { ticket, writer }: TeamNotice, now: Date): Promise<"go" | "last" | "capped"> {
  const caps: [string, number][] = [
    [`notice:ticket:${ticket.id}`, HOUR_LIMITS.noticesPerTicket],
    [`notice:contact:${writer.contactId}`, HOUR_LIMITS.noticesPerContact],
    ["notice:workspace", HOUR_LIMITS.noticesPerWorkspace],
  ];
  let last = false;
  for (const [bucket, limit] of caps) {
    const count = await countOneMore(tx, bucket, now);
    if (count > limit) return "capped";
    last ||= count === limit;
  }
  return last ? "last" : "go";
}

/** A page of the app for someone who may be in several workspaces: the browser enters this one first. */
const linkInto = (services: Pick<Services, "settings">, workspaceId: string, path: string) => new URL(`/workspace/${workspaceId}?${new URLSearchParams({ next: path })}`, services.settings.BETTER_AUTH_URL).toString();

async function tell(services: Services, workspaceId: string, notice: TeamNotice): Promise<NoticeOutcome> {
  const { ticket, writer } = notice;
  const team = await teamOf(services.db, workspaceId);
  const [preferences, productRow] = await withWorkspace(services.db, workspaceId, async (tx) => [await tx.select().from(notificationPreference), ticket.productId ? (await tx.select({ name: product.name }).from(product).where(eq(product.id, ticket.productId)))[0] : undefined] as const);
  const recipients = noticeRecipients({ team, preferences, assigneeId: ticket.assigneeId, productId: ticket.productId, writer });
  if (recipients.length === 0) return { status: "nobody" };
  const pace = await withWorkspace(services.db, workspaceId, (tx) => paceOf(tx, notice, services.now()));
  if (pace === "capped") return { status: "capped" };
  const [place] = await services.db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId));
  const content = noticeMail({ kind: notice.kind, number: ticket.number, subject: ticket.subject, words: notice.words, from: writer.email, productName: productRow?.name ?? null, workspaceName: place.name, ticketUrl: linkInto(services, workspaceId, `/tickets/${ticket.number}`), settingsUrl: linkInto(services, workspaceId, "/settings"), lastForNow: pace === "last" });
  await sendMachineMails(services.settings, services.fetch, recipients.map((to) => ({ to, ...content })), SEND_TIMEOUT_MS);
  return { status: "sent", to: recipients };
}

/** Writes the failure on the ticket, for the team only. If even that fails it goes to the log: the caller still carries on. */
async function recordFailure(services: Services, workspaceId: string, notice: TeamNotice, why: string): Promise<void> {
  try {
    await withWorkspace(services.db, workspaceId, (tx) => tx.insert(message).values({ ticketId: notice.ticket.id, kind: "system", body: FAILED(why) }));
  } catch (error) {
    console.error(`Ticket ${notice.ticket.id}: ${FAILED(why)}`, error);
  }
}

/** Mails the team about something that came in, if it should. With no mail on this instance, nothing is even read. */
export async function notifyTeam(services: Services, workspaceId: string, notice: TeamNotice): Promise<NoticeOutcome> {
  if (!hasOwnMail(services.settings)) return { status: "no_mail" };
  try {
    return await tell(services, workspaceId, notice);
  } catch (error) {
    const why = error instanceof Error ? error.message : "The mail service didn’t answer.";
    await recordFailure(services, workspaceId, notice, why);
    return { status: "failed", error: why };
  }
}

/** A member's own choice, in this workspace. */
export async function noticePreferenceOf(db: Database, workspaceId: string, userId: string): Promise<NoticePreference> {
  const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(notificationPreference).where(eq(notificationPreference.userId, userId)));
  return { userId, enabled: row?.enabled ?? true, mutedProductIds: row?.mutedProductIds ?? [] };
}

/**
 * Saves it from what they ticked: the products left unticked are muted, so a product added later is
 * heard about until they say otherwise. Only ids of this workspace's products are kept.
 */
export async function saveNoticePreference(db: Database, workspaceId: string, userId: string, enabled: boolean, wantedProductIds: readonly string[]): Promise<Tried> {
  await withWorkspace(db, workspaceId, async (tx) => {
    const products = await tx.select({ id: product.id }).from(product);
    const mutedProductIds = products.map(({ id }) => id).filter((id) => !wantedProductIds.includes(id));
    await tx
      .insert(notificationPreference)
      .values({ userId, enabled, mutedProductIds })
      .onConflictDoUpdate({ target: [notificationPreference.workspaceId, notificationPreference.userId], set: { enabled, mutedProductIds, updatedAt: sql`now()` } });
  });
  return { ok: true, said: enabled ? "Saved: you’ll be mailed about tickets." : "Saved: you won’t be mailed about tickets." };
}
