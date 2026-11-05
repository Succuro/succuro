import { and, eq, lt } from "drizzle-orm";
import type { Database } from "@/infrastructure/db/client";
import { message } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { scheduledWorkChanged } from "@/infrastructure/scheduling/scheduled-work";

export interface ScheduledWork {
  /** A reply is on its way out: if whatever was sending it dies, nobody else will notice. */
  repliesInFlight: boolean;
}

/** What the scheduled job has to do, across every workspace. Trusted path: it only ever says yes or no. */
export async function whatIsScheduled(db: Database): Promise<ScheduledWork> {
  const [inFlight] = await db.select({ id: message.id }).from(message).where(eq(message.deliveryState, "sending")).limit(1);
  return { repliesInFlight: Boolean(inFlight) };
}

/** Long enough that a send still running isn't touched: no function runs this long. */
const STUCK_AFTER_MS = 15 * 60_000;

const STUCK = "This reply stopped while it was being sent, and we can’t tell whether it left. Check with the requester, or send it again: a second try within a day won’t send it twice.";

/**
 * Replies whose sending died halfway (a function killed between marking and recording) become
 * failures a member can see and send again; otherwise they'd say "sending" for ever.
 */
export async function failStuckReplies(db: Database, now: Date): Promise<number> {
  const before = new Date(now.getTime() - STUCK_AFTER_MS);
  const stuck = await db
    .select({ id: message.id, workspaceId: message.workspaceId })
    .from(message)
    .where(and(eq(message.deliveryState, "sending"), lt(message.updatedAt, before)));
  for (const reply of stuck) {
    await withWorkspace(db, reply.workspaceId, (tx) => tx.update(message).set({ deliveryState: "failed", deliveryError: STUCK }).where(and(eq(message.id, reply.id), eq(message.deliveryState, "sending"))));
  }
  // Asked again next time: the answer that sent this run here is now out of date.
  scheduledWorkChanged();
  return stuck.length;
}
