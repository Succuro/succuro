import { bearerJson, requestJson } from "../connectors/http";
import type { Env } from "../env";

type OwnMailSettings = Pick<Env, "RESEND_API_KEY" | "SUCCURO_MAIL_FROM">;

const EMAILS = "https://api.resend.com/emails";
const LARGEST_BATCH = 100;

/** Whether this instance can send its own mail at all. */
export const hasOwnMail = (settings: Pick<Env, "RESEND_API_KEY">) => Boolean(settings.RESEND_API_KEY);

/**
 * The instance's own mail to its members, through Resend (https://resend.com/docs/api-reference/emails/send-email):
 * sign-in links, invitations and notifications. Replies to customers leave through each workspace's
 * own connection. An instance without a key simply sends none of its own.
 */
export async function sendOwnMail(settings: OwnMailSettings, fetchUrl: typeof fetch, mail: { to: string; subject: string; text: string }): Promise<boolean> {
  if (!settings.RESEND_API_KEY) return false;
  await requestJson(fetchUrl, "Resend", EMAILS, {
    method: "POST",
    headers: bearerJson(settings.RESEND_API_KEY),
    body: JSON.stringify({ from: settings.SUCCURO_MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
  });
  return true;
}

export interface MachineMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Says a machine wrote this (RFC 3834), which is what stops an out-of-office answering it. It also
 * keeps the mail from opening a ticket if it comes back in: an address on a team can be a support address.
 */
export const MACHINE_MAIL_HEADERS = { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" };

/**
 * Several of the instance's own mails, written by a machine, in one request per batch
 * (https://resend.com/docs/api-reference/emails/send-batch-emails): a team of ten would otherwise be
 * ten requests against the provider's limit per second. Each person gets their own, so a mail never
 * shows who else got it. Bounded in time: whoever is waiting shouldn't hang on a slow provider.
 */
export async function sendMachineMails(settings: OwnMailSettings, fetchUrl: typeof fetch, mails: readonly MachineMail[], timeoutMs: number): Promise<boolean> {
  if (!settings.RESEND_API_KEY) return false;
  for (let start = 0; start < mails.length; start += LARGEST_BATCH) {
    const batch = mails.slice(start, start + LARGEST_BATCH).map(({ to, subject, text }) => ({ from: settings.SUCCURO_MAIL_FROM, to: [to], subject, text, headers: MACHINE_MAIL_HEADERS }));
    await requestJson(fetchUrl, "Resend", `${EMAILS}/batch`, { method: "POST", headers: bearerJson(settings.RESEND_API_KEY), body: JSON.stringify(batch), signal: AbortSignal.timeout(timeoutMs) });
  }
  return true;
}
