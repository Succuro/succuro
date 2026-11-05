import { revalidateTag } from "next/cache";

/**
 * What the scheduled job knows without asking the database: whether it has anything to do. It lives
 * in the platform's cache, so a job with nothing to do doesn't wake a database that bills by the hour
 * it is awake. Whatever gives it work, or takes it away, clears it.
 */
export const SCHEDULED_WORK_TAG = "scheduled-work";

/**
 * Clears what's known, so the next run asks. Next applies it when the request's route returns, so a
 * change has to happen before that. Outside a request (a test, a script) nothing is cached to clear.
 */
export function scheduledWorkChanged(): void {
  try {
    revalidateTag(SCHEDULED_WORK_TAG, { expire: 0 });
  } catch {
    // Only reachable outside a request; at worst the job finds out at the cache's daily refresh.
  }
}
