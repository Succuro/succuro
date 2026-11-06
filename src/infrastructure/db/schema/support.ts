import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, tenantIsolation, updatedAt, workspaceColumn } from "./shared";
import { workspace } from "./tenancy";

const ownedByWorkspace = () => workspaceColumn().references(() => workspace.id, { onDelete: "cascade" });

// ─── The desk ──────────────────────────────────────────────────────────────
//
// Every table here is a workspace's own, behind row-level security. Only three lookups come before
// any workspace is known (a product's public key, an API key's hash, a connection's address), on
// the trusted path; everything after them runs bound to the workspace they name.

/** A brand or project inside a workspace, so one company can run several products from one inbox. */
export const product = pgTable(
  "product",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: ownedByWorkspace(),
    name: text().notNull(),
    slug: text().notNull(),
    colour: text().notNull().default("#6b7a90"),
    /** Where its mail is received and sent from; empty until a member sets it, and nothing can be emailed then. */
    supportAddress: text(),
    /** New mail on the support address waits in Screened with this product already chosen, rather than opening a ticket. */
    screensSupportAddress: boolean().notNull().default(false),
    senderName: text(),
    /** Public by design: it sits in the widget's snippet on a website, and only ever opens tickets. */
    publicKey: text().notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.workspaceId, table.slug), tenantIsolation()],
).enableRLS();

/**
 * Where else a product receives, beyond the support address its replies leave from: one address, or a
 * domain for every address on it. A value belongs to one product, so a mail can't mean two of them.
 */
export const productAddress = pgTable(
  "product_address",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: ownedByWorkspace(),
    productId: uuid()
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    /** Lowercased: `help@acme.example`, or `acme.example` for every address there. */
    value: text().notNull(),
    /** New mail here waits in Screened with this product already chosen, rather than opening a ticket. */
    screens: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.workspaceId, table.value), index().on(table.productId), tenantIsolation()],
).enableRLS();

/** Someone who writes in: one per address in a workspace. */
export const contact = pgTable(
  "contact",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: ownedByWorkspace(),
    /** Lowercased. */
    email: text().notNull(),
    name: text(),
    /** Their id in the app that sent them, when one did. */
    externalId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.workspaceId, table.email), index().on(table.workspaceId, table.externalId), tenantIsolation()],
).enableRLS();

/** How a workspace sorts its tickets; it starts with a default set (domain/tickets) and changes it. */
export const category = pgTable(
  "category",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: ownedByWorkspace(),
    name: text().notNull(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [unique().on(table.workspaceId, table.name), tenantIsolation()],
).enableRLS();

export const ticketStatus = pgEnum("ticket_status", ["open", "pending", "resolved", "closed"]);
export const ticketPriority = pgEnum("ticket_priority", ["low", "normal", "high", "urgent"]);
export const ticketChannel = pgEnum("ticket_channel", ["email", "web", "api", "assistant"]);

export const ticket = pgTable(
  "ticket",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: ownedByWorkspace(),
    /** Counted per workspace (ticket_counter): what people say to each other. */
    number: integer().notNull(),
    subject: text().notNull(),
    /** Open waits on support, pending waits on the requester. */
    status: ticketStatus().notNull().default("open"),
    priority: ticketPriority().notNull().default("normal"),
    categoryId: uuid().references(() => category.id, { onDelete: "set null" }),
    productId: uuid().references(() => product.id, { onDelete: "set null" }),
    contactId: uuid()
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    assigneeId: text().references(() => user.id, { onDelete: "set null" }),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    channel: ticketChannel().notNull(),
    /** What it is about, as the app that sent it knows it: an order, a course, a page. */
    aboutType: text(),
    aboutId: text(),
    aboutTitle: text(),
    aboutUrl: text(),
    /** Free context from the app: page, version, operating system. */
    context: jsonb().$type<Record<string, unknown>>(),
    /** The part of the reply address that finds this ticket again. Random, so it can't be guessed. */
    replyToken: text().notNull(),
    /** Part of every requester link: raising it ends the links already sent. */
    linkVersion: integer().notNull().default(1),
    firstResponseAt: timestamp({ withTimezone: true }),
    resolvedAt: timestamp({ withTimezone: true }),
    lastMessageAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique().on(table.workspaceId, table.number),
    unique().on(table.workspaceId, table.replyToken),
    index().on(table.workspaceId, table.status, table.lastMessageAt),
    index().on(table.workspaceId, table.contactId),
    index().on(table.workspaceId, table.assigneeId),
    tenantIsolation(),
  ],
).enableRLS();

/** The next number for each workspace: taking one locks its row, so concurrent tickets queue and every number is used once. */
export const ticketCounter = pgTable(
  "ticket_counter",
  {
    workspaceId: ownedByWorkspace().primaryKey(),
    last: integer().notNull(),
  },
  () => [tenantIsolation()],
).enableRLS();

export const messageKind = pgEnum("message_kind", ["customer", "agent", "note", "system"]);
export const messageWriter = pgEnum("message_writer", ["member", "assistant"]);
export const deliveryState = pgEnum("delivery_state", ["draft", "sending", "sent", "delivered", "delayed", "bounced", "complained", "failed"]);

export interface NotedAttachment {
  filename: string;
  contentType: string;
  size: number | null;
}

/**
 * One entry of a conversation. Who may see it depends on its kind: a note and a system line are for
 * the team only, and application/requester.ts reads with a list of what a requester may see, so a
 * new kind stays hidden until someone decides otherwise.
 */
export const message = pgTable(
  "message",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: ownedByWorkspace(),
    ticketId: uuid()
      .notNull()
      .references(() => ticket.id, { onDelete: "cascade" }),
    kind: messageKind().notNull(),
    body: text().notNull(),
    /** The member it went out under, for a reply or a note. */
    authorUserId: text().references(() => user.id, { onDelete: "set null" }),
    authorContactId: uuid().references(() => contact.id, { onDelete: "set null" }),
    /** Who wrote the words: a reply an assistant drafted says so even once a member sent it. */
    writtenBy: messageWriter(),
    /** Only for replies: empty on everything that isn't sent anywhere. */
    deliveryState: deliveryState(),
    /** Why it didn't reach them, in the member's words. */
    deliveryError: text(),
    /** The provider's id: the same received mail is recorded once, and delivery reports find their reply. */
    providerId: text(),
    /** The Message-ID header, which a reply's In-Reply-To names. */
    emailMessageId: text(),
    emailInReplyTo: text(),
    emailReferences: text().array().notNull().default(sql`'{}'::text[]`),
    /** The address a received mail came from, kept when it isn't the requester's. */
    fromAddress: text(),
    /** The mail's own checks failed (SPF, DKIM, DMARC): anyone may have written it. */
    senderSuspect: boolean().notNull().default(false),
    /** Attachments aren't kept yet: what arrived is recorded, so nothing vanishes without a word. */
    attachments: jsonb().$type<NotedAttachment[]>().notNull().default([]),
    /** The clock rather than the transaction's start: a message and the line that follows it in one transaction stay in order. */
    createdAt: timestamp({ withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    updatedAt: updatedAt(),
  },
  (table) => [
    index().on(table.ticketId, table.createdAt),
    uniqueIndex().on(table.workspaceId, table.providerId).where(sql`provider_id is not null`),
    uniqueIndex().on(table.workspaceId, table.emailMessageId).where(sql`email_message_id is not null`),
    index().on(table.deliveryState).where(sql`delivery_state = 'sending'`),
    tenantIsolation(),
  ],
).enableRLS();

export const screenReason = pgEnum("screen_reason", ["no_product", "address_rule", "machine", "service_flag", "forged", "own_address", "no_sender"]);
export const screenedState = pgEnum("screened_state", ["waiting", "promoted", "dismissed"]);

/**
 * A new mail that didn't open a ticket, kept whole until a member decides. Nothing here has touched
 * the desk: no contact was made for it, nobody was told, and it's never answered. A decision is
 * recorded rather than the row removed, so the same mail posted again stays known.
 */
export const screenedMail = pgTable(
  "screened_mail",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: ownedByWorkspace(),
    providerId: text().notNull(),
    emailMessageId: text(),
    emailInReplyTo: text(),
    emailReferences: text().array().notNull().default(sql`'{}'::text[]`),
    /** As the mail gave it, which may be no address at all. */
    fromAddress: text().notNull(),
    fromName: text(),
    addressedTo: text().array().notNull().default(sql`'{}'::text[]`),
    subject: text().notNull(),
    body: text().notNull(),
    senderSuspect: boolean().notNull().default(false),
    attachments: jsonb().$type<NotedAttachment[]>().notNull().default([]),
    reason: screenReason().notNull(),
    /** The product its address points to, already chosen when a member opens a ticket from it. */
    productId: uuid().references(() => product.id, { onDelete: "set null" }),
    state: screenedState().notNull().default("waiting"),
    /** The ticket it became, once promoted. */
    ticketId: uuid().references(() => ticket.id, { onDelete: "set null" }),
    decidedBy: text().references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamp({ withTimezone: true }),
    /** When the mail service received it. */
    receivedAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex().on(table.workspaceId, table.providerId),
    uniqueIndex().on(table.workspaceId, table.emailMessageId).where(sql`email_message_id is not null`),
    index().on(table.workspaceId, table.state, table.receivedAt),
    tenantIsolation(),
  ],
).enableRLS();

export const savedReply = pgTable(
  "saved_reply",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: ownedByWorkspace(),
    title: text().notNull(),
    body: text().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.workspaceId, table.title), tenantIsolation()],
).enableRLS();

/** One row per workspace, once a member changed anything. Absent means the defaults, which are the careful ones. */
export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    workspaceId: ownedByWorkspace().primaryKey(),
    /** Whether an assistant may send a reply once its member said yes. Off: replies wait for a member. */
    assistantMaySend: boolean().notNull().default(false),
    updatedAt: updatedAt(),
  },
  () => [tenantIsolation()],
).enableRLS();

/** What a member wants to be mailed about, in this workspace. Absent means everything. */
export const notificationPreference = pgTable(
  "notification_preference",
  {
    workspaceId: ownedByWorkspace(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    enabled: boolean().notNull().default(true),
    /** Products they don't want mail about. An id whose product is gone just matches nothing. */
    mutedProductIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.userId] }), tenantIsolation()],
).enableRLS();

/** How many requests a public path took in a window: serverless instances share no memory, so the count lives here. */
export const requestCount = pgTable(
  "request_count",
  {
    workspaceId: ownedByWorkspace(),
    /** What is counted: a product's form from one hashed address, a requester's link. */
    bucket: text().notNull(),
    windowStart: timestamp({ withTimezone: true }).notNull(),
    count: integer().notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.bucket, table.windowStart] }), tenantIsolation()],
).enableRLS();
