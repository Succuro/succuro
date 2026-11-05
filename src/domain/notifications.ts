import { oneLine } from "./ticket-input";

/**
 * Who hears about a ticket, and what the mail says. Pure: the use case reads the team and sends. The
 * words in these mails come from strangers and reach people through the instance's own address, so
 * they must not be able to pose as the instance: nothing clickable of theirs goes through.
 */

export type NoticeKind = "new_ticket" | "requester_answered";

export interface NoticePreference {
  userId: string;
  enabled: boolean;
  mutedProductIds: string[];
}

export interface TeammateAddress {
  userId: string;
  email: string;
}

/** No preference saved means yes: a new member hears about tickets until they say otherwise. */
export const wantsNotices = (preference: NoticePreference | undefined, productId: string | null) => (preference?.enabled ?? true) && !(productId && preference?.mutedProductIds.includes(productId));

export interface WhoToTell {
  team: readonly TeammateAddress[];
  preferences: readonly NoticePreference[];
  assigneeId: string | null;
  productId: string | null;
  /** Whoever wrote this hears nothing about their own words. A member can be both, writing in from their own address. */
  writer: { email: string; userId?: string | null };
}

/**
 * The addresses to mail: the assignee if there is one still on the team, otherwise everyone. An off
 * switch holds either way: someone holding a ticket who turned mail off has chosen to watch the inbox.
 */
export function noticeRecipients({ team, preferences, assigneeId, productId, writer }: WhoToTell): string[] {
  const assignee = team.find(({ userId }) => userId === assigneeId);
  const candidates = assignee ? [assignee] : team;
  const writerAddress = writer.email.toLowerCase();
  return candidates
    .filter(({ userId, email }) => userId !== writer.userId && email.toLowerCase() !== writerAddress)
    .filter(({ userId }) => wantsNotices(preferences.find((preference) => preference.userId === userId), productId))
    .map(({ email }) => email);
}

/** Anything a mail client would turn into a link, an address included. Run on a bounded slice of the text, so it can't be made to take long. */
const LINKS = /\b(?:[a-z][a-z0-9+.-]*:\/\/\S+|mailto:\S+|www\.\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/\S*)?)/gi;
/** Characters that reorder or hide text, which can make one thing read as another. */
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g;
const LONGEST_READ = 2_000;

/** A stranger's words made safe to quote: one line, no links, no invisible characters, and short. */
export function untrustedExcerpt(text: string, longest: number): string {
  const line = oneLine(text.slice(0, LONGEST_READ).replace(INVISIBLE, "")).replace(LINKS, "[link removed]");
  return line.length > longest ? `${line.slice(0, longest).trimEnd()}…` : line;
}

const EXCERPT_LENGTH = 280;
const SUBJECT_LENGTH = 120;

export interface NoticeContent {
  kind: NoticeKind;
  number: number;
  subject: string;
  words: string;
  from: string;
  productName: string | null;
  workspaceName: string;
  ticketUrl: string;
  settingsUrl: string;
  /** This is the last one for now: past it the team would otherwise think nothing more came in. */
  lastForNow: boolean;
}

const HEADLINES: Record<NoticeKind, string> = { new_ticket: "New ticket", requester_answered: "New answer" };

/** The notification itself, in plain text. It links to the ticket on this instance and to nothing the requester wrote. */
export function noticeMail({ kind, number, subject, words, from, productName, workspaceName, ticketUrl, settingsUrl, lastForNow }: NoticeContent): { subject: string; text: string } {
  const headline = HEADLINES[kind];
  const label = productName ? `${productName} #${number}` : `#${number}`;
  const safeSubject = untrustedExcerpt(subject, SUBJECT_LENGTH);
  return {
    subject: `[${label}] ${headline}: ${safeSubject}`,
    text: [
      `${headline} in ${workspaceName}: ${label}.`,
      "",
      `From: ${from}`,
      `Subject: ${safeSubject}`,
      "",
      "What they wrote, from outside your team and not checked. Its links are removed here:",
      `| ${untrustedExcerpt(words, EXCERPT_LENGTH)}`,
      "",
      `Open the ticket: ${ticketUrl}`,
      "",
      ...(lastForNow ? ["That’s the last mail for now about this ticket or this person: more may come in during this hour, and the inbox will have it.", ""] : []),
      `Replies to this mail go nowhere: answer from the ticket. To stop these, or for one product: ${settingsUrl}`,
      "",
    ].join("\n"),
  };
}
