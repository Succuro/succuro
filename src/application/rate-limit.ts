import { lt, sql } from "drizzle-orm";
import type { Database } from "@/infrastructure/db/client";
import { requestCount } from "@/infrastructure/db/schema/support";

const HOUR_MS = 3_600_000;

export const HOUR_LIMITS = {
  /** From one address, on one product's form: what a person might really need. */
  formFromOneAddress: 5,
  /** On one product's form, from everywhere: stops a flood from many addresses without closing the door for long. */
  formInAll: 200,
  /** Answers through one requester's link: someone is writing, not a script. */
  requesterAnswers: 20,
  /** Tickets through one API key: ten a minute, held for an hour. An app in a loop stops here, and a busy one can make a second key. */
  ticketsPerKey: 600,
  /** Mails to the team about one ticket, however often it moves. */
  noticesPerTicket: 3,
  /** Mails to the team about one person, however many tickets they open. */
  noticesPerContact: 5,
  /** Mails to the team in a workspace, for a flood that comes from many addresses at once. */
  noticesPerWorkspace: 100,
} as const;

export const hourWindowOf = (now: Date) => new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);

/** How long until this hour's window ends, for a Retry-After header: at least a second, since zero means "now". */
export const secondsUntilNextWindow = (now: Date) => Math.max(1, Math.ceil((hourWindowOf(now).getTime() + HOUR_MS - now.getTime()) / 1000));

/**
 * Counts one more request in this hour's window, inside the caller's workspace, and says how many
 * that makes. Old windows go as new ones come, since a counter is the only thing here nothing else cleans up.
 */
export async function countOneMore(tx: Database, bucket: string, now: Date): Promise<number> {
  const windowStart = hourWindowOf(now);
  await tx.delete(requestCount).where(lt(requestCount.windowStart, windowStart));
  const [counted] = await tx
    .insert(requestCount)
    .values({ bucket, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [requestCount.workspaceId, requestCount.bucket, requestCount.windowStart], set: { count: sql`${requestCount.count} + 1` } })
    .returning({ count: requestCount.count });
  return counted.count;
}

/** Counts one more, and says whether it fits. */
export const takesOneMore = async (tx: Database, bucket: string, limit: number, now: Date): Promise<boolean> => (await countOneMore(tx, bucket, now)) <= limit;
