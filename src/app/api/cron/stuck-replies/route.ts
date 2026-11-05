import { failStuckReplies } from "@/application/scheduled-work";
import { db } from "@/infrastructure/db/client";
import { cronRefusal, scheduledWork } from "../scheduled-work";

/** The one scheduled job: replies whose sending died. With none in flight it answers without touching the database. */
export async function GET(request: Request) {
  const refusal = cronRefusal(request);
  if (refusal) return refusal;
  if (!(await scheduledWork()).repliesInFlight) return Response.json({ failed: 0, idle: true });
  return Response.json({ failed: await failStuckReplies(db(), new Date()) });
}
