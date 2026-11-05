import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { receiveHook, recordInboundMail } from "@/application/inbound-mail";
import { recordDeliveryReport } from "@/application/delivery-reports";
import { replyNow } from "@/application/replies";
import { ticketForTeam } from "@/application/ticket-queries";
import { updateTicket } from "@/application/tickets";
import type { Database } from "@/infrastructure/db/client";
import { connection } from "@/infrastructure/db/schema/connections";
import { contact, ticket } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { addProduct, connectResend, inboundEmail, NOW, openTicket, RESEND_DOMAINS, RESEND_SENDS, signedRequest, testServices } from "./support/desk";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

async function desk() {
  const { workspaceId, userId } = await createTestWorkspace(db);
  const { services } = testServices(db);
  const product = await addProduct(db, workspaceId, userId);
  return { workspaceId, userId, services, product };
}

const ticketRow = async (workspaceId: string, number: number) => (await withWorkspace(db, workspaceId, (tx) => tx.select().from(ticket).where(eq(ticket.number, number))))[0];
const allTickets = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(ticket));
const messagesOf = async (workspaceId: string, number: number) => (await ticketForTeam(db, workspaceId, number))?.messages ?? [];

describe("a mail that matches nothing", () => {
  it("opens a new ticket for the product it was sent to", async () => {
    const { workspaceId, services, product } = await desk();
    const email = inboundEmail({ subject: " Can’t sign in ", text: "Help" });
    expect(await recordInboundMail(services, workspaceId, email)).toBe("opened");
    const [opened] = await allTickets(workspaceId);
    expect(opened).toMatchObject({ number: 1, subject: "Can’t sign in", channel: "email", status: "open", productId: product.id });
    const [first] = await messagesOf(workspaceId, 1);
    expect(first).toMatchObject({ kind: "customer", body: "Help", providerId: email.providerId, emailMessageId: email.messageId });
  });

  it("files it by address among several products, and with no product when none matches", async () => {
    const { workspaceId, userId, services } = await desk();
    const other = await addProduct(db, workspaceId, userId, "Other", "help@other.example");
    await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ["help@other.example"] }));
    await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ["nobody@elsewhere.example"] }));
    expect((await ticketRow(workspaceId, 1)).productId).toBe(other.id);
    expect((await ticketRow(workspaceId, 2)).productId).toBeNull();
  });

  it("gives a mail with no subject or text words to show", async () => {
    const { workspaceId, services } = await desk();
    await recordInboundMail(services, workspaceId, inboundEmail({ subject: "  ", text: "" }));
    expect((await ticketRow(workspaceId, 1)).subject).toBe("(no subject)");
    expect((await messagesOf(workspaceId, 1))[0].body).toBe("(This mail had no text.)");
  });

  it("makes the requester once, and keeps the first name it heard", async () => {
    const { workspaceId, services } = await desk();
    await recordInboundMail(services, workspaceId, inboundEmail({ from: "ada@customer.example", fromName: "Ada Martin" }));
    await recordInboundMail(services, workspaceId, inboundEmail({ from: "ada@customer.example", fromName: "The CEO" }));
    const people = await withWorkspace(db, workspaceId, (tx) => tx.select().from(contact));
    expect(people).toMatchObject([{ email: "ada@customer.example", name: "Ada Martin" }]);
  });

  it("cuts one that's too long, and says so", async () => {
    const { workspaceId, services } = await desk();
    await recordInboundMail(services, workspaceId, inboundEmail({ text: "x".repeat(30_000) }));
    const [first] = await messagesOf(workspaceId, 1);
    expect(first.body).toContain("(This mail was cut here");
    expect(first.body.length).toBeLessThan(20_200);
  });
});

describe("a mail that continues a ticket", () => {
  it("is matched by the token in the address it was sent to, whatever else it says", async () => {
    const { workspaceId, services } = await desk();
    const { number } = await openTicket(services, workspaceId);
    const { replyToken } = await ticketRow(workspaceId, number);
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ subject: "Something else entirely", addressedTo: [`support+${replyToken}@acme.example`] }))).toBe("continued");
    expect(await allTickets(workspaceId)).toHaveLength(1);
    expect(await messagesOf(workspaceId, number)).toHaveLength(2);
  });

  it("is matched by In-Reply-To, naming a mail this ticket has", async () => {
    const { workspaceId, services } = await desk();
    const first = inboundEmail();
    await recordInboundMail(services, workspaceId, first);
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ inReplyTo: first.messageId }))).toBe("continued");
    expect(await allTickets(workspaceId)).toHaveLength(1);
  });

  it("is matched by References, the latest it knows", async () => {
    const { workspaceId, services } = await desk();
    const first = inboundEmail({ subject: "First" });
    const second = inboundEmail({ subject: "Second" });
    await recordInboundMail(services, workspaceId, first);
    await recordInboundMail(services, workspaceId, second);
    await recordInboundMail(services, workspaceId, inboundEmail({ references: ["<unknown@x>", first.messageId as string, second.messageId as string] }));
    expect(await messagesOf(workspaceId, 2)).toHaveLength(2);
    expect(await messagesOf(workspaceId, 1)).toHaveLength(1);
  });

  it("is matched to a reply once the service has told us its Message-ID", async () => {
    const { workspaceId, userId, product } = await desk();
    const { services } = testServices(db);
    await connectResend(services, workspaceId, userId);
    const { number } = await openTicket(services, workspaceId, { product: product.slug });
    await replyNow(services, workspaceId, number, "We’re on it.", { userId, writtenBy: "member" });
    await recordDeliveryReport(services, workspaceId, { providerId: "resend-sent-1", outcome: "sent", messageId: "<sent-by-resend@acme.example>", detail: null });
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ inReplyTo: "<sent-by-resend@acme.example>" }))).toBe("continued");
    expect(await allTickets(workspaceId)).toHaveLength(1);
    expect((await messagesOf(workspaceId, number)).at(-1)).toMatchObject({ kind: "customer" });
  });

  it("opens a new ticket when its token and headers name nothing here", async () => {
    const { workspaceId, services } = await desk();
    await openTicket(services, workspaceId);
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ["support+aaaaaaaaaaaaaaaaaaaa@acme.example"], inReplyTo: "<unknown@x>" }))).toBe("opened");
    expect(await allTickets(workspaceId)).toHaveLength(2);
  });

  it("can't reach another workspace's ticket, even with its token or its Message-ID", async () => {
    const mine = await desk();
    const theirs = await desk();
    const foreign = inboundEmail();
    await recordInboundMail(theirs.services, theirs.workspaceId, foreign);
    const { replyToken } = await ticketRow(theirs.workspaceId, 1);
    expect(await recordInboundMail(mine.services, mine.workspaceId, inboundEmail({ addressedTo: [`support+${replyToken}@acme.example`] }))).toBe("opened");
    expect(await recordInboundMail(mine.services, mine.workspaceId, inboundEmail({ inReplyTo: foreign.messageId }))).toBe("opened");
    expect(await messagesOf(theirs.workspaceId, 1)).toHaveLength(1);
  });

  it("drops the conversation the mail client quoted back", async () => {
    const { workspaceId, services } = await desk();
    const first = inboundEmail();
    await recordInboundMail(services, workspaceId, first);
    await recordInboundMail(services, workspaceId, inboundEmail({ inReplyTo: first.messageId, text: "Thanks!\n\nOn Tue, 3 Nov 2026, Support wrote:\n> We’re on it." }));
    expect((await messagesOf(workspaceId, 1)).at(-1)?.body).toBe("Thanks!");
  });

  it("reopens a settled ticket and says so, and puts a pending one back with support", async () => {
    const { workspaceId, userId, services } = await desk();
    const { number } = await openTicket(services, workspaceId);
    const { replyToken } = await ticketRow(workspaceId, number);
    await updateTicket(services, workspaceId, number, { status: "closed" }, { userId, writtenBy: "member" });
    expect((await ticketRow(workspaceId, number)).resolvedAt).not.toBeNull();
    await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: [`support+${replyToken}@acme.example`] }));
    expect(await ticketRow(workspaceId, number)).toMatchObject({ status: "open", resolvedAt: null });
    expect((await messagesOf(workspaceId, number)).at(-1)).toMatchObject({ kind: "system", body: "Reopened: the requester wrote again." });
    await updateTicket(services, workspaceId, number, { status: "pending" }, { userId, writtenBy: "member" });
    await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: [`support+${replyToken}@acme.example`] }));
    expect((await ticketRow(workspaceId, number)).status).toBe("open");
  });

  it("notes when someone other than the requester wrote, without changing who the ticket is for", async () => {
    const { workspaceId, services } = await desk();
    const { number } = await openTicket(services, workspaceId);
    const { replyToken, contactId } = await ticketRow(workspaceId, number);
    await recordInboundMail(services, workspaceId, inboundEmail({ from: "colleague@customer.example", fromName: "A Colleague", addressedTo: [`support+${replyToken}@acme.example`] }));
    expect((await ticketRow(workspaceId, number)).contactId).toBe(contactId);
    expect((await messagesOf(workspaceId, number)).at(-1)).toMatchObject({ kind: "customer", fromAddress: "colleague@customer.example" });
  });

  it("flags a sender whose mail fails its own checks, and still keeps the words", async () => {
    const { workspaceId, services } = await desk();
    await recordInboundMail(services, workspaceId, inboundEmail({ authentication: { dmarc: "fail" } }));
    expect((await messagesOf(workspaceId, 1))[0].senderSuspect).toBe(true);
  });
});

describe("what isn't a person writing", () => {
  it("doesn't open a ticket, or answer itself", async () => {
    const { workspaceId, services } = await desk();
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ from: "no address here" }))).toBe("ignored");
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ headers: { "auto-submitted": "auto-replied" } }))).toBe("ignored");
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ from: "support@acme.example" }))).toBe("ignored");
    expect(await allTickets(workspaceId)).toEqual([]);
  });

  it("is noted on a ticket it answers, without reopening it or counting as an answer", async () => {
    const { workspaceId, userId, services } = await desk();
    const { number } = await openTicket(services, workspaceId);
    const before = await ticketRow(workspaceId, number);
    await updateTicket(services, workspaceId, number, { status: "resolved" }, { userId, writtenBy: "member" });
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: [`support+${before.replyToken}@acme.example`], headers: { "auto-submitted": "auto-replied" }, text: "I’m away until Monday." }))).toBe("noted");
    expect(await ticketRow(workspaceId, number)).toMatchObject({ status: "resolved", lastMessageAt: before.lastMessageAt });
    expect((await messagesOf(workspaceId, number)).at(-1)).toMatchObject({ kind: "system", body: expect.stringContaining("I’m away until Monday.") });
  });
});

describe("the same mail twice", () => {
  it("is recorded once, by the service's id or by its Message-ID", async () => {
    const { workspaceId, services } = await desk();
    const email = inboundEmail();
    await recordInboundMail(services, workspaceId, email);
    expect(await recordInboundMail(services, workspaceId, email)).toBe("duplicate");
    expect(await recordInboundMail(services, workspaceId, { ...email, providerId: "another-copy" })).toBe("duplicate");
    expect(await allTickets(workspaceId)).toHaveLength(1);
  });

  it("leaves no second ticket when two copies race", async () => {
    const { workspaceId, services } = await desk();
    const email = inboundEmail();
    const outcomes = await Promise.all([recordInboundMail(services, workspaceId, email), recordInboundMail(services, workspaceId, email)]);
    expect(outcomes.sort()).toEqual(["duplicate", "opened"]);
    expect(await allTickets(workspaceId)).toHaveLength(1);
  });
});

describe("an attachment", () => {
  it("is recorded as having existed, never dropped in silence", async () => {
    const { workspaceId, services } = await desk();
    await recordInboundMail(services, workspaceId, inboundEmail({ attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", size: 2048 }] }));
    expect((await messagesOf(workspaceId, 1))[0].attachments).toEqual([{ filename: "invoice.pdf", contentType: "application/pdf", size: 2048 }]);
  });
});

describe("the hook's address", () => {
  const RECEIVED = JSON.stringify({ type: "email.received", data: { email_id: "mail-1", from: "ada@customer.example", to: ["support@acme.example"] } });
  const FETCHES_MAIL = { match: "GET https://api.resend.com/emails/receiving/mail-1", json: { id: "mail-1", from: "ada@customer.example", to: ["support@acme.example"], subject: "From the hook", text: "Hello", headers: {}, message_id: "<hook@customer.example>" } };

  async function connected() {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services, calls } = testServices(db, [RESEND_DOMAINS, RESEND_SENDS, FETCHES_MAIL]);
    await addProduct(db, workspaceId, userId);
    const made = await connectResend(services, workspaceId, userId);
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, made.id)));
    return { workspaceId, services, calls, id: made.id, token: row.hookToken };
  }

  it("opens a ticket from a signed mail", async () => {
    const { workspaceId, services, id, token } = await connected();
    expect(await receiveHook(services, id, token, signedRequest(RECEIVED))).toEqual({ status: 200, body: "opened" });
    expect(await allTickets(workspaceId)).toMatchObject([{ subject: "From the hook" }]);
  });

  it("records one mail posted twice once, as a retry does", async () => {
    const { workspaceId, services, id, token } = await connected();
    await receiveHook(services, id, token, signedRequest(RECEIVED));
    expect(await receiveHook(services, id, token, signedRequest(RECEIVED))).toEqual({ status: 200, body: "duplicate" });
    expect(await allTickets(workspaceId)).toHaveLength(1);
  });

  it("refuses a forged signature with a 401, touching nothing", async () => {
    const { workspaceId, services, calls, id, token } = await connected();
    const before = calls.length;
    const forged = signedRequest(RECEIVED, { secret: `whsec_${Buffer.from("guess").toString("base64")}` });
    const answer = await receiveHook(services, id, token, forged);
    expect(answer.status).toBe(401);
    expect(calls).toHaveLength(before);
    expect(await allTickets(workspaceId)).toEqual([]);
  });

  it("refuses a replayed signature from long ago", async () => {
    const { services, id, token } = await connected();
    const old = signedRequest(RECEIVED, { at: new Date(NOW.getTime() - 3_600_000) });
    expect((await receiveHook(services, id, token, old)).status).toBe(401);
  });

  it("answers 404 to a wrong or missing token, before opening anything", async () => {
    const { services, id } = await connected();
    expect(await receiveHook(services, id, "wrong", signedRequest(RECEIVED))).toEqual({ status: 404 });
    expect(await receiveHook(services, id, null, signedRequest(RECEIVED))).toEqual({ status: 404 });
    expect(await receiveHook(services, crypto.randomUUID(), "any", signedRequest(RECEIVED))).toEqual({ status: 404 });
  });

  it("makes the service try again when credentials can't be opened, rather than failing without a word", async () => {
    const { workspaceId, id, token } = await connected();
    const { services: rekeyed } = testServices(db);
    const wrongKey = { ...rekeyed, settings: { ...rekeyed.settings, SUCCURO_SECRETS_KEY: Buffer.alloc(32, 9).toString("base64") } };
    expect((await receiveHook(wrongKey, id, token, signedRequest(RECEIVED))).status).toBe(500);
    expect(await allTickets(workspaceId)).toEqual([]);
  });

  it("records a delivery report", async () => {
    const { services, id, token } = await connected();
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "unknown-mail", message_id: "<x@y>" } });
    expect(await receiveHook(services, id, token, signedRequest(body))).toEqual({ status: 200, body: "ignored" });
  });
});

describe("what became of a reply", () => {
  async function sent() {
    const { workspaceId, userId, product } = await desk();
    const { services } = testServices(db);
    await connectResend(services, workspaceId, userId);
    const { number } = await openTicket(services, workspaceId, { product: product.slug });
    await replyNow(services, workspaceId, number, "We’re on it.", { userId, writtenBy: "member" });
    const reply = () => messagesOf(workspaceId, number).then((all) => all.find(({ kind }) => kind === "agent"));
    return { workspaceId, services, number, reply };
  }

  it("moves forward as reports come, and a late one doesn't undo it", async () => {
    const { workspaceId, services, reply } = await sent();
    const report = (outcome: "sent" | "delivered") => recordDeliveryReport(services, workspaceId, { providerId: "resend-sent-1", outcome, messageId: "<m@x>", detail: null });
    await report("delivered");
    expect(await reply()).toMatchObject({ deliveryState: "delivered", emailMessageId: "<m@x>" });
    await report("sent");
    expect((await reply())?.deliveryState).toBe("delivered");
  });

  it("says plainly when it bounced, and puts the ticket back with the team", async () => {
    const { workspaceId, services, number, reply } = await sent();
    expect((await ticketRow(workspaceId, number)).status).toBe("pending");
    await recordDeliveryReport(services, workspaceId, { providerId: "resend-sent-1", outcome: "bounced", messageId: null, detail: "No such mailbox" });
    expect(await reply()).toMatchObject({ deliveryState: "bounced", deliveryError: "This reply bounced: No such mailbox" });
    expect((await ticketRow(workspaceId, number)).status).toBe("open");
    expect((await messagesOf(workspaceId, number)).at(-1)).toMatchObject({ kind: "system", body: "This reply bounced: No such mailbox" });
  });

  it("says when it was marked as spam, or the service couldn't send it", async () => {
    const { workspaceId, services, reply } = await sent();
    await recordDeliveryReport(services, workspaceId, { providerId: "resend-sent-1", outcome: "complained", messageId: null, detail: null });
    expect((await reply())?.deliveryError).toBe("The recipient marked this reply as spam.");
    const other = await sent();
    await recordDeliveryReport(other.services, other.workspaceId, { providerId: "resend-sent-1", outcome: "failed", messageId: null, detail: "Rejected" });
    expect((await other.reply())?.deliveryError).toBe("The mail service couldn’t send this reply: Rejected");
  });

  it("finds nothing for another workspace's reply", async () => {
    const { reply } = await sent();
    const elsewhere = await desk();
    expect(await recordDeliveryReport(elsewhere.services, elsewhere.workspaceId, { providerId: "resend-sent-1", outcome: "bounced", messageId: null, detail: null })).toBe("ignored");
    expect((await reply())?.deliveryState).toBe("sent");
  });
});
