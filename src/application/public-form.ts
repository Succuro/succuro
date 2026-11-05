import { firstProblem, publicFormInput } from "@/domain/ticket-input";
import { sha256 } from "@/infrastructure/crypto/secrets";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { notifyTeam } from "./notifications";
import { productOfPublicKey } from "./products";
import { HOUR_LIMITS, takesOneMore } from "./rate-limit";
import type { Services } from "./services";
import { openTicketIn } from "./tickets";

export type FormAnswer = { status: 201; number: number } | { status: 200 } | { status: 400 | 404 | 429; error: string };

/** The field a person never sees and a form-filling robot fills. */
export const HONEYPOT_FIELD = "website";

/**
 * A ticket from a website's form or widget, from a stranger. A filled honeypot gets the same kind of
 * success a person would, and touches nothing: telling a robot it failed teaches it to do better.
 * Nothing is mailed here, on purpose: an open form that sends mail to whatever address it's given
 * would let anyone use it against anyone. The first mail is a member's reply.
 */
export async function receivePublicForm(services: Services, raw: unknown, clientAddress: string | null): Promise<FormAnswer> {
  const fields = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof fields[HONEYPOT_FIELD] === "string" && fields[HONEYPOT_FIELD].trim() !== "") return { status: 200 };
  const parsed = publicFormInput.safeParse(fields);
  if (!parsed.success) return { status: 400, error: firstProblem(parsed.error) };
  const { key, email, name, subject, message, about, context } = parsed.data;
  const found = await productOfPublicKey(services.db, key);
  if (!found) return { status: 404, error: "This form isn’t open." };
  // Hashed: the count needs to tell two addresses apart, not to know them. Unknown behind no proxy: every visitor would share one count, so only the form's ceiling applies.
  const fromAddress = clientAddress && sha256(`${clientAddress}:${services.settings.BETTER_AUTH_SECRET}`);
  const opened = await withWorkspace(services.db, found.workspaceId, async (tx) => {
    const now = services.now();
    if (fromAddress && !(await takesOneMore(tx, `form:${found.id}:${fromAddress}`, HOUR_LIMITS.formFromOneAddress, now))) return { refused: "Too many requests from here: please try again in an hour." };
    if (!(await takesOneMore(tx, `form:${found.id}`, HOUR_LIMITS.formInAll, now))) return { refused: "This form is taking too many requests: please try again in an hour." };
    return { created: await openTicketIn(tx, { subject, body: message, requester: { email, name }, channel: "web", productId: found.id, about, context }, now) };
  });
  if (!opened.created) return { status: 429, error: opened.refused as string };
  const { created } = opened;
  await notifyTeam(services, found.workspaceId, { kind: "new_ticket", ticket: created, writer: { contactId: created.contactId, email }, words: message });
  return { status: 201, number: created.number };
}
