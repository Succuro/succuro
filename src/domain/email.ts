import { oneLine } from "./ticket-input";

/**
 * Reading and writing mail's own conventions: addresses, threads and what machines send. Everything
 * here takes what a stranger's mail says, so nothing trusts it and nothing throws on it.
 */

export interface ParsedAddress {
  address: string;
  name: string | null;
}

/** `Ada Martin <ada@acme.example>` or a bare address; null when there is no address in it. */
export function parseAddress(value: string): ParsedAddress | null {
  const bracketed = /^([\s\S]*)<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value.trim());
  const address = (bracketed?.[2] ?? value).trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) return null;
  const name = oneLine(bracketed?.[1]).replace(/^"(.*)"$/, "$1").slice(0, 120);
  return { address, name: name || null };
}

/** The token alphabet: lowercase and digits, since mail servers may lowercase an address. */
const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const TOKEN_LENGTH = 20;

/** A reply token from random bytes: about 100 bits, short enough to fit a mail address's local part. */
export const replyTokenFrom = (bytes: Uint8Array) =>
  Array.from(bytes.slice(0, TOKEN_LENGTH), (byte) => TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length]).join("");

export const REPLY_TOKEN_BYTES = TOKEN_LENGTH;

/** Where a ticket's answers go: the product's address, with the ticket's token after a plus. */
export function replyAddress(supportAddress: string, token: string): string {
  const at = supportAddress.lastIndexOf("@");
  return `${supportAddress.slice(0, at)}+${token}${supportAddress.slice(at)}`;
}

const TOKEN_IN_ADDRESS = new RegExp(`\\+([${TOKEN_ALPHABET}]{${TOKEN_LENGTH}})@`);

/** The first reply token among the addresses a mail was sent to. */
export function replyTokenIn(addresses: readonly string[]): string | null {
  for (const address of addresses) {
    const found = TOKEN_IN_ADDRESS.exec(address.toLowerCase());
    if (found) return found[1];
  }
  return null;
}

/** The address without what follows a plus: the one a product is known by. */
export const withoutPlus = (address: string) => address.toLowerCase().replace(/\+[^@]*@/, "@");

const MESSAGE_ID = /<[^<>\s]+>/g;

/** The Message-IDs in an In-Reply-To or References header. */
export const messageIdsIn = (header: string | null | undefined): string[] => header?.match(MESSAGE_ID) ?? [];

/** The thread a reply continues: what it answers, and everything before that, oldest first and once each. */
export function threadOf(known: readonly (string | null | undefined)[]): { inReplyTo?: string; references: string[] } {
  const references = [...new Set(known.filter((id): id is string => Boolean(id)))];
  return { inReplyTo: references.at(-1), references };
}

export const replySubject = (subject: string) => (/^(re|aw|sv|réf)\s*:/i.test(subject) ? subject : `Re: ${subject}`);

/** How a sender appears: quotes and line breaks in a name would forge a header. */
export function senderHeader(name: string | null | undefined, address: string): string {
  const shown = oneLine(name).replace(/["\\<>]/g, "");
  return shown ? `${shown} <${address}>` : address;
}

const AUTOMATED_PRECEDENCE = new Set(["bulk", "junk", "list", "auto_reply"]);
const DELIVERY_ROBOT = /^(mailer-daemon|postmaster|mail-daemon)@/i;

/**
 * Whether a machine wrote this: an out-of-office, a bounce, a mailing list. Such mail must not open
 * tickets or put a closed one back in the queue, and two robots answering each other would never stop.
 */
export function isAutomatedMail(headers: Readonly<Record<string, string>>, from: string): boolean {
  const said = (name: string) => headers[name]?.trim().toLowerCase();
  const submitted = said("auto-submitted");
  if (submitted && submitted !== "no") return true;
  if (said("x-autoreply") || said("x-autorespond") || said("x-auto-response-suppress") || said("list-id") || said("x-failed-recipients")) return true;
  if (AUTOMATED_PRECEDENCE.has(said("precedence") ?? "")) return true;
  // An empty return path is how a mail says no answer is wanted, and a delivery report says what it is in its type.
  if (said("return-path") === "<>" || said("content-type")?.includes("report-type=delivery-status")) return true;
  return DELIVERY_ROBOT.test(from);
}

export interface MailAuthentication {
  spf?: string;
  dkim?: string;
  dmarc?: string;
}

/** The sender's domain denies having sent this, or neither proof holds: the From line may be anyone. */
export const senderLooksForged = ({ spf, dkim, dmarc }: MailAuthentication) => dmarc === "fail" || (spf === "fail" && dkim === "fail");

const QUOTE_STARTS = [/^on .{1,300} wrote:\s*$/im, /^le .{1,300} a écrit\s*:\s*$/im, /^-{2,}\s*original message\s*-{2,}\s*$/im, /^from:\s.+\n(sent|date):\s/im];

/**
 * What someone wrote above the conversation their mail client quotes back. Mail has no marker for
 * it, so this looks for the usual forms; when in doubt the whole text stays, since showing too much
 * is better than losing what a customer said.
 */
export function withoutQuotedReply(text: string): string {
  const starts = QUOTE_STARTS.map((pattern) => text.search(pattern)).filter((at) => at >= 0);
  const cut = starts.length > 0 ? text.slice(0, Math.min(...starts)) : text;
  const lines = cut.split(/\r?\n/);
  while (lines.length > 0 && (lines.at(-1)?.startsWith(">") || lines.at(-1)?.trim() === "")) lines.pop();
  const kept = lines.join("\n").trim();
  return kept || text.trim();
}
