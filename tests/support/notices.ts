import type { Services } from "@/application/services";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { member } from "@/infrastructure/db/schema/tenancy";
import { NOW, RESEND_DOMAINS, RESEND_SENDS, testServices } from "./desk";
import type { FakeRoute, RecordedCall } from "./fetch";

/** Answers the instance's notifications; ahead of the plain send, whose address it starts with. */
export const RESEND_BATCH: FakeRoute = { match: "POST https://api.resend.com/emails/batch", json: { data: [{ id: "notice-1" }] } };

export const INSTANCE_KEY = "re_instance_key";
export const MAIL_FROM = "Desk <no-reply@succuro.test>";

/** Services on an instance that has its own mail. */
export function mailingServices(db: Database, routes: FakeRoute[] = [RESEND_BATCH, RESEND_DOMAINS, RESEND_SENDS], now = NOW) {
  const { services, calls } = testServices(db, routes, now);
  const mailing: Services = { ...services, settings: { ...services.settings, RESEND_API_KEY: INSTANCE_KEY, SUCCURO_MAIL_FROM: MAIL_FROM } };
  return { services: mailing, calls };
}

export interface CaughtNotice {
  from: string;
  to: string[];
  subject: string;
  text: string;
  headers: Record<string, string>;
}

/** Every notification in what was posted, batches opened up. */
export const noticesIn = (calls: readonly RecordedCall[]): CaughtNotice[] => calls.filter(({ url }) => url.endsWith("/emails/batch")).flatMap(({ body }) => JSON.parse(body) as CaughtNotice[]);

export const recipientsIn = (calls: readonly RecordedCall[]) => noticesIn(calls).flatMap(({ to }) => to).sort();

/** Someone else on the team, with an address the test can look for. */
export async function addTeammate(db: Database, workspaceId: string, role: "admin" | "member" = "member", name = "Bea") {
  const userId = crypto.randomUUID();
  const email = `${name.toLowerCase()}-${userId}@example.test`;
  await db.insert(user).values({ id: userId, name, email });
  await db.insert(member).values({ workspaceId, userId, role });
  return { userId, email };
}
