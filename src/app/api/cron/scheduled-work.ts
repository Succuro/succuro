import { cacheLife, cacheTag } from "next/cache";
import { whatIsScheduled, type ScheduledWork } from "@/application/scheduled-work";
import { sameSecret } from "@/infrastructure/crypto/secrets";
import { db } from "@/infrastructure/db/client";
import { env } from "@/infrastructure/env";
import { SCHEDULED_WORK_TAG } from "@/infrastructure/scheduling/scheduled-work";

const DAY_SECONDS = 86_400;

/**
 * What the job has to do, kept outside the database so that asking doesn't wake it. Whatever
 * changes it clears it at once; the daily refresh is only the safety net for a change made by hand.
 */
export async function scheduledWork(): Promise<ScheduledWork> {
  "use cache: remote";
  cacheTag(SCHEDULED_WORK_TAG);
  cacheLife({ revalidate: DAY_SECONDS, expire: 2 * DAY_SECONDS });
  return whatIsScheduled(db());
}

/** The refusal for anyone but the platform's scheduler, or null when it's the scheduler. */
export function cronRefusal(request: Request): Response | null {
  // The header first: a build prerenders this route, and has no environment to read.
  const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const secret = env().CRON_SECRET;
  return secret && sameSecret(given, secret) ? null : new Response(null, { status: 401 });
}
