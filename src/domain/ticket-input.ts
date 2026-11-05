import { z } from "zod";
import { TICKET_PRIORITIES } from "./tickets";

/**
 * What may come into a ticket from outside, checked and cleaned before anything is stored. Forms,
 * apps and assistants all pass through here, so a limit holds wherever a ticket comes from.
 */

export const SUBJECT_MAX = 200;
export const BODY_MAX = 20_000;
const NAME_MAX = 120;
const ID_MAX = 200;
const TAG_MAX = 40;
const TAGS_MAX = 20;
/** The app's context JSON, in bytes once serialised. */
const CONTEXT_MAX_BYTES = 8_192;

/** One line: control characters and line breaks would forge a mail header or break a list. */
export const oneLine = (text: unknown) =>
  String(text ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Tags: one line each, lowercase, deduplicated. */
export function cleanTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => oneLine(tag).toLowerCase().slice(0, TAG_MAX)).filter(Boolean))].slice(0, TAGS_MAX);
}

const line = (max: number) => z.string().transform(oneLine).pipe(z.string().max(max));
const optionalLine = (max: number) =>
  line(max)
    .optional()
    .nullable()
    .transform((value) => value || undefined);

export const emailAddress = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.email());

/** Only a web address may become a link on a member's screen: anything else (a javascript: one) stays out. */
const webAddress = z
  .string()
  .max(2_000)
  .refine((value) => /^https?:\/\//i.test(value) && URL.canParse(value), "must be an http or https address")
  .optional()
  .nullable()
  .transform((value) => value || undefined);

export const aboutInput = z.object({ type: optionalLine(60), id: optionalLine(ID_MAX), title: optionalLine(SUBJECT_MAX), url: webAddress });
export type About = z.infer<typeof aboutInput>;

export const contextInput = z
  .record(z.string(), z.unknown())
  .refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= CONTEXT_MAX_BYTES, `context must stay under ${CONTEXT_MAX_BYTES} bytes`);

export const requesterInput = z.object({ email: emailAddress, name: optionalLine(NAME_MAX), externalId: optionalLine(ID_MAX) });

export interface Requester {
  email: string;
  name?: string;
  externalId?: string;
}

export const subjectInput = line(SUBJECT_MAX).pipe(z.string().min(1, "a subject is needed"));
export const bodyInput = z.string().trim().min(1, "a message is needed").max(BODY_MAX, `a message stays under ${BODY_MAX} characters`);
export const tagsInput = z.array(z.string()).max(100).transform(cleanTags);

/** A ticket as an app sends it. Its product and category are names only that workspace can resolve. */
export const newTicketInput = z.object({
  subject: subjectInput,
  message: bodyInput,
  requester: requesterInput,
  product: optionalLine(80),
  category: optionalLine(80),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  tags: tagsInput.optional(),
  about: aboutInput.optional(),
  context: contextInput.optional(),
});
export type NewTicketInput = z.infer<typeof newTicketInput>;

/** A ticket as the public form sends it: fewer fields, since whoever posts it is a stranger. */
export const publicFormInput = z.object({
  key: z.string().regex(/^pk_[A-Za-z0-9_-]{16,64}$/, "unknown form"),
  email: emailAddress,
  name: optionalLine(NAME_MAX),
  subject: subjectInput,
  message: bodyInput,
  about: aboutInput.optional(),
  context: contextInput.optional(),
});
export type PublicFormInput = z.infer<typeof publicFormInput>;

/** The first problem with what was sent, in words the sender can act on. */
export const firstProblem = (error: z.ZodError) => {
  const [issue] = error.issues;
  return issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
};
