import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { recordInboundMail } from "@/application/inbound-mail";
import { noticePreferenceOf, notifyTeam, saveNoticePreference, type TeamNotice } from "@/application/notifications";
import { receivePublicForm } from "@/application/public-form";
import { HOUR_LIMITS } from "@/application/rate-limit";
import { replyNow } from "@/application/replies";
import { answerAsRequester, seeAsRequester } from "@/application/requester";
import { removeMember } from "@/application/team";
import { listTickets, ticketForTeam } from "@/application/ticket-queries";
import { createTicket, updateTicket } from "@/application/tickets";
import { noticeMail, noticeRecipients, untrustedExcerpt, wantsNotices } from "@/domain/notifications";
import { newTicketInput } from "@/domain/ticket-input";
import type { Database } from "@/infrastructure/db/client";
import { ticket } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { addProduct, connectResend, inboundEmail, NOW, openTicket, RESEND_DOMAINS, RESEND_SENDS } from "./support/desk";
import { addTeammate, INSTANCE_KEY, MAIL_FROM, mailingServices, noticesIn, recipientsIn, RESEND_BATCH } from "./support/notices";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

/** A workspace of two on an instance with mail, a product, and the owner's address. */
async function desk(routes = [RESEND_BATCH, RESEND_DOMAINS, RESEND_SENDS]) {
  const { workspaceId, userId } = await createTestWorkspace(db, "Acme");
  const { services, calls } = mailingServices(db, routes);
  const product = await addProduct(db, workspaceId, userId);
  const bea = await addTeammate(db, workspaceId);
  const ada = `${userId}@example.test`;
  return { workspaceId, userId, services, calls, product, bea, ada, actor: { userId, writtenBy: "member" as const } };
}

const openFromApp = (seat: Awaited<ReturnType<typeof desk>>, overrides = {}) => openTicket(seat.services, seat.workspaceId, { product: seat.product.slug, ...overrides });
const tokenOf = (url: string) => new URL(url).pathname.split("/t/")[1];
const row = async (workspaceId: string, number: number) => (await withWorkspace(db, workspaceId, (tx) => tx.select().from(ticket).where(eq(ticket.number, number))))[0];
const systemLines = async (workspaceId: string, number: number) => ((await ticketForTeam(db, workspaceId, number))?.messages ?? []).filter(({ kind }) => kind === "system").map(({ body }) => body);

describe("who is told", () => {
  const team = [{ userId: "ada", email: "ada@acme.example" }, { userId: "bea", email: "bea@acme.example" }, { userId: "cal", email: "cal@acme.example" }];
  const base = { team, preferences: [], assigneeId: null, productId: "p1", writer: { email: "stranger@customer.example" } };
  const everyone = ["ada@acme.example", "bea@acme.example", "cal@acme.example"];

  it("is everyone when nobody holds it", () => {
    expect(noticeRecipients(base)).toEqual(everyone);
  });

  it("is the assignee alone when someone does", () => {
    expect(noticeRecipients({ ...base, assigneeId: "bea" })).toEqual(["bea@acme.example"]);
  });

  it("is everyone again when the assignee has left the team", () => {
    expect(noticeRecipients({ ...base, assigneeId: "gone" })).toEqual(everyone);
  });

  it("never includes who wrote it, by id or by address, whatever the capitals", () => {
    expect(noticeRecipients({ ...base, writer: { email: "x@y.example", userId: "ada" } })).toEqual(["bea@acme.example", "cal@acme.example"]);
    expect(noticeRecipients({ ...base, writer: { email: "BEA@Acme.Example" } })).toEqual(["ada@acme.example", "cal@acme.example"]);
    expect(noticeRecipients({ ...base, assigneeId: "bea", writer: { email: "bea@acme.example" } })).toEqual([]);
  });

  it("leaves out whoever turned it off, the assignee included", () => {
    const off = { userId: "bea", enabled: false, mutedProductIds: [] };
    expect(noticeRecipients({ ...base, preferences: [off] })).toEqual(["ada@acme.example", "cal@acme.example"]);
    expect(noticeRecipients({ ...base, preferences: [off], assigneeId: "bea" })).toEqual([]);
  });

  it("leaves out whoever muted the product, and only for that product", () => {
    const muted = [{ userId: "ada", enabled: true, mutedProductIds: ["p1"] }];
    expect(noticeRecipients({ ...base, preferences: muted })).toEqual(["bea@acme.example", "cal@acme.example"]);
    expect(noticeRecipients({ ...base, preferences: muted, productId: "p2" })).toEqual(everyone);
    expect(noticeRecipients({ ...base, preferences: muted, productId: null })).toEqual(everyone);
  });

  it("defaults to yes", () => {
    expect(wantsNotices(undefined, "p1")).toBe(true);
    expect(wantsNotices({ userId: "a", enabled: false, mutedProductIds: [] }, null)).toBe(false);
  });
});

describe("what a stranger's words become", () => {
  it.each([
    ["Click https://evil.example/login now", "Click [link removed] now"],
    ["Go to HTTP://EVIL.example", "Go to [link removed]"],
    ["See www.evil.example/x", "See [link removed]"],
    ["evil.example/reset please", "[link removed] please"],
    ["visit evil.example today", "visit [link removed] today"],
    ["write to boss@evil.example", "write to [link removed]"],
    ["mailto:boss@evil.example", "[link removed]"],
    ["ftp://evil.example/file", "[link removed]"],
  ])("loses what a mail client would link: %s", (words, safe) => {
    expect(untrustedExcerpt(words, 200)).toBe(safe);
  });

  it("is one line, whatever it held", () => {
    expect(untrustedExcerpt("Hello\r\n\r\nBcc: boss\t  there\u0000", 200)).toBe("Hello Bcc: boss there");
  });

  it("loses characters that hide or reorder text", () => {
    expect(untrustedExcerpt("pay‮evil‬​ now", 200)).toBe("payevil now");
  });

  it("is cut when long, and says so", () => {
    expect(untrustedExcerpt("word ".repeat(100), 20)).toBe("word word word word…");
  });

  it("stays quick on what's built to slow it down", () => {
    const started = Date.now();
    untrustedExcerpt(`${"a.".repeat(50_000)}!`, 200);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("keeps ordinary words and versions", () => {
    expect(untrustedExcerpt("It broke on 3.1.0, e.g. after login. Thanks!", 200)).toBe("It broke on 3.1.0, e.g. after login. Thanks!");
  });
});

describe("the mail", () => {
  const content = { kind: "new_ticket" as const, number: 12, subject: "Refund\r\nBcc: x https://evil.example", words: "Pay https://evil.example now", from: "cleo@customer.example", productName: "Acme App", workspaceName: "Acme", ticketUrl: "https://succuro.test/ticket", settingsUrl: "https://succuro.test/settings", lastForNow: false };

  it("says what, where, from whom, and links to the ticket", () => {
    const { subject, text } = noticeMail(content);
    expect(subject).toBe("[Acme App #12] New ticket: Refund Bcc: x [link removed]");
    expect(text).toContain("New ticket in Acme: Acme App #12.");
    expect(text).toContain("From: cleo@customer.example");
    expect(text).toContain("Open the ticket: https://succuro.test/ticket");
    expect(text).toContain("https://succuro.test/settings");
  });

  it("says the words aren't checked, and carries nothing clickable of theirs", () => {
    const { subject, text } = noticeMail(content);
    expect(text).toContain("from outside your team and not checked");
    expect(`${subject}${text}`).not.toContain("evil.example");
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it("names an answer as an answer, and a ticket with no product by its number", () => {
    expect(noticeMail({ ...content, kind: "requester_answered", productName: null }).subject).toMatch(/^\[#12\] New answer: /);
  });

  it("says when it's the last for now", () => {
    expect(noticeMail(content).text).not.toContain("last mail for now");
    expect(noticeMail({ ...content, lastForNow: true }).text).toContain("last mail for now");
  });
});

describe("a ticket arriving", () => {
  it("by an app tells the team, through the instance's own mail and never the workspace's connection", async () => {
    const seat = await desk();
    await connectResend(seat.services, seat.workspaceId, seat.userId);
    const { number } = await openFromApp(seat, { subject: "Refund", message: "Please refund order 42." });
    expect(recipientsIn(seat.calls)).toEqual([seat.ada, seat.bea.email].sort());
    const [call] = seat.calls.filter(({ url }) => url.endsWith("/emails/batch"));
    expect(call.headers.get("authorization")).toBe(`Bearer ${INSTANCE_KEY}`);
    const [mail] = noticesIn(seat.calls);
    expect(mail).toMatchObject({ from: MAIL_FROM, subject: `[Acme App #${number}] New ticket: Refund` });
    expect(mail.text).toContain("Please refund order 42.");
    expect(mail.text).toContain(`https://succuro.test/workspace/${seat.workspaceId}?next=%2Ftickets%2F${number}`);
  });

  it("gives each person a mail of their own, so nobody sees who else got it", async () => {
    const seat = await desk();
    await openFromApp(seat);
    for (const { to } of noticesIn(seat.calls)) expect(to).toHaveLength(1);
  });

  it("marks the mail as a machine's, so an out-of-office doesn't answer it", async () => {
    const seat = await desk();
    await openFromApp(seat);
    expect(noticesIn(seat.calls)[0].headers).toEqual({ "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" });
  });

  it("carries no link a requester's page would answer to", async () => {
    const seat = await desk();
    await openFromApp(seat);
    expect(noticesIn(seat.calls)[0].text).not.toContain("/t/");
  });

  it("by the public form tells the team too", async () => {
    const seat = await desk();
    expect(await receivePublicForm(seat.services, { key: seat.product.publicKey, email: "dee@customer.example", subject: "From the form", message: "Hello" }, "203.0.113.1")).toMatchObject({ status: 201 });
    expect(noticesIn(seat.calls)[0].subject).toContain("From the form");
    expect(recipientsIn(seat.calls)).toEqual([seat.ada, seat.bea.email].sort());
  });

  it("doesn't tell anyone about a filled honeypot or a refused form", async () => {
    const seat = await desk();
    await receivePublicForm(seat.services, { key: seat.product.publicKey, website: "https://spam.example", email: "x@y.example", subject: "A", message: "B" }, "203.0.113.1");
    await receivePublicForm(seat.services, { key: seat.product.publicKey, email: "nope", subject: "A", message: "B" }, "203.0.113.1");
    expect(noticesIn(seat.calls)).toEqual([]);
  });

  it("by email tells the team, once, however often it's posted", async () => {
    const seat = await desk();
    const email = inboundEmail({ subject: "By mail" });
    expect(await recordInboundMail(seat.services, seat.workspaceId, email)).toBe("opened");
    expect(await recordInboundMail(seat.services, seat.workspaceId, email)).toBe("duplicate");
    expect(noticesIn(seat.calls)).toHaveLength(2);
    expect(noticesIn(seat.calls)[0].subject).toContain("By mail");
  });

  it("recorded by a member tells the others, not them", async () => {
    const seat = await desk();
    const input = newTicketInput.parse({ subject: "By phone", message: "They called.", requester: { email: "cleo@customer.example" } });
    await createTicket(seat.services, seat.workspaceId, input, { channel: "web", recordedBy: seat.actor });
    expect(recipientsIn(seat.calls)).toEqual([seat.bea.email]);
  });

  it("recorded through an assistant doesn't tell the member it works for", async () => {
    const seat = await desk();
    const input = newTicketInput.parse({ subject: "By phone", message: "They called.", requester: { email: "cleo@customer.example" } });
    await createTicket(seat.services, seat.workspaceId, input, { channel: "assistant", recordedBy: { userId: seat.userId, writtenBy: "assistant" } });
    expect(recipientsIn(seat.calls)).toEqual([seat.bea.email]);
  });

  it("from a member's own address doesn't tell them", async () => {
    const seat = await desk();
    await recordInboundMail(seat.services, seat.workspaceId, inboundEmail({ from: seat.bea.email }));
    expect(recipientsIn(seat.calls)).toEqual([seat.ada]);
  });

  it("stays in its workspace", async () => {
    const seat = await desk();
    const elsewhere = await desk();
    await openFromApp(seat);
    expect(recipientsIn(seat.calls)).not.toContain(elsewhere.ada);
    expect(recipientsIn(seat.calls)).not.toContain(elsewhere.bea.email);
  });
});

describe("a requester answering", () => {
  it("by their page tells the assignee alone", async () => {
    const seat = await desk();
    const { number, requesterUrl } = await openFromApp(seat);
    await updateTicket(seat.services, seat.workspaceId, number, { assigneeId: seat.bea.userId }, seat.actor);
    seat.calls.length = 0;
    expect((await answerAsRequester(seat.services, tokenOf(requesterUrl), "Here’s more.")).ok).toBe(true);
    expect(recipientsIn(seat.calls)).toEqual([seat.bea.email]);
    expect(noticesIn(seat.calls)[0]).toMatchObject({ subject: expect.stringContaining("New answer") });
    expect(noticesIn(seat.calls)[0].text).toContain("Here’s more.");
  });

  it("by their page tells everyone when nobody holds it", async () => {
    const seat = await desk();
    const { requesterUrl } = await openFromApp(seat);
    seat.calls.length = 0;
    await answerAsRequester(seat.services, tokenOf(requesterUrl), "Here’s more.");
    expect(recipientsIn(seat.calls)).toEqual([seat.ada, seat.bea.email].sort());
  });

  it("by email tells the assignee, or everyone", async () => {
    const seat = await desk();
    const { number } = await openFromApp(seat);
    const { replyToken } = await row(seat.workspaceId, number);
    seat.calls.length = 0;
    await recordInboundMail(seat.services, seat.workspaceId, inboundEmail({ addressedTo: [`support+${replyToken}@acme.example`], text: "Everyone." }));
    expect(recipientsIn(seat.calls)).toEqual([seat.ada, seat.bea.email].sort());
    await updateTicket(seat.services, seat.workspaceId, number, { assigneeId: seat.userId }, seat.actor);
    seat.calls.length = 0;
    await recordInboundMail(seat.services, seat.workspaceId, inboundEmail({ addressedTo: [`support+${replyToken}@acme.example`], text: "Just the assignee." }));
    expect(recipientsIn(seat.calls)).toEqual([seat.ada]);
  });

  it("by email, written by another person, names who wrote it", async () => {
    const seat = await desk();
    const { number } = await openFromApp(seat);
    const { replyToken } = await row(seat.workspaceId, number);
    seat.calls.length = 0;
    await recordInboundMail(seat.services, seat.workspaceId, inboundEmail({ from: "colleague@customer.example", addressedTo: [`support+${replyToken}@acme.example`] }));
    expect(noticesIn(seat.calls)[0].text).toContain("From: colleague@customer.example");
  });

  it("goes to everyone again once the assignee has left", async () => {
    const seat = await desk();
    const { number, requesterUrl } = await openFromApp(seat);
    await updateTicket(seat.services, seat.workspaceId, number, { assigneeId: seat.bea.userId }, seat.actor);
    await removeMember(db, seat.workspaceId, seat.userId, seat.bea.userId);
    seat.calls.length = 0;
    await answerAsRequester(seat.services, tokenOf(requesterUrl), "Still there?");
    expect(recipientsIn(seat.calls)).toEqual([seat.ada]);
  });

  it("isn't told when the team replies, or adds a note", async () => {
    const seat = await desk();
    await connectResend(seat.services, seat.workspaceId, seat.userId);
    const { number } = await openFromApp(seat);
    seat.calls.length = 0;
    await replyNow(seat.services, seat.workspaceId, number, "On it.", seat.actor);
    expect(noticesIn(seat.calls)).toEqual([]);
  });
});

describe("the off switch", () => {
  it("stops the mail for that member, and only them", async () => {
    const seat = await desk();
    await saveNoticePreference(db, seat.workspaceId, seat.bea.userId, false, []);
    await openFromApp(seat);
    expect(recipientsIn(seat.calls)).toEqual([seat.ada]);
  });

  it("holds when the ticket is theirs: nobody else is mailed in their place", async () => {
    const seat = await desk();
    const { number, requesterUrl } = await openFromApp(seat);
    await updateTicket(seat.services, seat.workspaceId, number, { assigneeId: seat.bea.userId }, seat.actor);
    await saveNoticePreference(db, seat.workspaceId, seat.bea.userId, false, [seat.product.id]);
    seat.calls.length = 0;
    await answerAsRequester(seat.services, tokenOf(requesterUrl), "Hello?");
    expect(noticesIn(seat.calls)).toEqual([]);
  });

  it("can be turned back on", async () => {
    const seat = await desk();
    await saveNoticePreference(db, seat.workspaceId, seat.bea.userId, false, []);
    await saveNoticePreference(db, seat.workspaceId, seat.bea.userId, true, [seat.product.id]);
    await openFromApp(seat);
    expect(recipientsIn(seat.calls)).toContain(seat.bea.email);
  });

  it("can be for one product: leaving it unticked mutes it, and a product added later is heard about", async () => {
    const seat = await desk();
    const other = await addProduct(db, seat.workspaceId, seat.userId, "Other", "help@other.example");
    await saveNoticePreference(db, seat.workspaceId, seat.bea.userId, true, [other.id]);
    expect((await noticePreferenceOf(db, seat.workspaceId, seat.bea.userId)).mutedProductIds).toEqual([seat.product.id]);
    await openFromApp(seat);
    expect(recipientsIn(seat.calls)).toEqual([seat.ada]);
    seat.calls.length = 0;
    await openFromApp(seat, { product: other.slug, requester: { email: "bea-customer@customer.example" } });
    expect(recipientsIn(seat.calls)).toEqual([seat.ada, seat.bea.email].sort());
    const later = await addProduct(db, seat.workspaceId, seat.userId, "Later", "later@acme.example");
    seat.calls.length = 0;
    await openFromApp(seat, { product: later.slug, requester: { email: "another@customer.example" } });
    expect(recipientsIn(seat.calls)).toContain(seat.bea.email);
  });

  it("is on by default, and is each workspace's own", async () => {
    const seat = await desk();
    expect(await noticePreferenceOf(db, seat.workspaceId, seat.userId)).toEqual({ userId: seat.userId, enabled: true, mutedProductIds: [] });
    const elsewhere = await desk();
    await saveNoticePreference(db, seat.workspaceId, seat.userId, false, []);
    expect((await noticePreferenceOf(db, elsewhere.workspaceId, seat.userId)).enabled).toBe(true);
  });

  it("keeps no product of another workspace", async () => {
    const seat = await desk();
    const elsewhere = await desk();
    await saveNoticePreference(db, seat.workspaceId, seat.userId, true, [elsewhere.product.id, seat.product.id]);
    expect((await noticePreferenceOf(db, seat.workspaceId, seat.userId)).mutedProductIds).toEqual([]);
  });

  it("is forgotten when they leave, so coming back starts from the default", async () => {
    const seat = await desk();
    await saveNoticePreference(db, seat.workspaceId, seat.bea.userId, false, []);
    await removeMember(db, seat.workspaceId, seat.userId, seat.bea.userId);
    expect((await noticePreferenceOf(db, seat.workspaceId, seat.bea.userId)).enabled).toBe(true);
  });
});

describe("a burst", () => {
  it("from one person on one ticket is capped, and the last mail says so", async () => {
    const seat = await desk();
    const { number } = await openFromApp(seat);
    const { replyToken } = await row(seat.workspaceId, number);
    for (let sent = 0; sent < 10; sent++) await recordInboundMail(seat.services, seat.workspaceId, inboundEmail({ addressedTo: [`support+${replyToken}@acme.example`], text: `Message ${sent}` }));
    const mails = noticesIn(seat.calls);
    expect(mails).toHaveLength(HOUR_LIMITS.noticesPerTicket * 2);
    expect(mails.at(-1)?.text).toContain("last mail for now");
    expect(mails[0].text).not.toContain("last mail for now");
    expect((await ticketForTeam(db, seat.workspaceId, number))?.messages.filter(({ kind }) => kind === "customer")).toHaveLength(11);
  });

  it("from one person across many tickets is capped, while every ticket still opens", async () => {
    const seat = await desk();
    for (let sent = 0; sent < 12; sent++) await recordInboundMail(seat.services, seat.workspaceId, inboundEmail({ subject: `Ticket ${sent}` }));
    expect(noticesIn(seat.calls)).toHaveLength(HOUR_LIMITS.noticesPerContact * 2);
    expect(noticesIn(seat.calls).at(-1)?.text).toContain("last mail for now");
    expect((await listTickets(db, seat.workspaceId, {})).tickets).toHaveLength(12);
  });

  it("from one person leaves someone else's request alone", async () => {
    const seat = await desk();
    for (let sent = 0; sent < 8; sent++) await recordInboundMail(seat.services, seat.workspaceId, inboundEmail({ from: "noisy@customer.example" }));
    seat.calls.length = 0;
    await recordInboundMail(seat.services, seat.workspaceId, inboundEmail({ from: "quiet@customer.example", subject: "Real question" }));
    expect(noticesIn(seat.calls)[0].subject).toContain("Real question");
  });

  it("on one ticket doesn't use up that person's allowance elsewhere", async () => {
    const seat = await desk();
    const { number } = await openFromApp(seat);
    const { replyToken } = await row(seat.workspaceId, number);
    for (let sent = 0; sent < 10; sent++) await recordInboundMail(seat.services, seat.workspaceId, inboundEmail({ addressedTo: [`support+${replyToken}@acme.example`] }));
    seat.calls.length = 0;
    await recordInboundMail(seat.services, seat.workspaceId, inboundEmail({ subject: "A new one, same person" }));
    expect(noticesIn(seat.calls)).toHaveLength(2);
  });

  it("from many addresses is capped for the workspace", async () => {
    const seat = await desk();
    const { requestCount } = await import("@/infrastructure/db/schema/support");
    const { hourWindowOf } = await import("@/application/rate-limit");
    await withWorkspace(db, seat.workspaceId, (tx) => tx.insert(requestCount).values({ bucket: "notice:workspace", windowStart: hourWindowOf(NOW), count: HOUR_LIMITS.noticesPerWorkspace - 1 }));
    await recordInboundMail(seat.services, seat.workspaceId, inboundEmail({ from: "one@customer.example" }));
    expect(noticesIn(seat.calls).at(-1)?.text).toContain("last mail for now");
    seat.calls.length = 0;
    await recordInboundMail(seat.services, seat.workspaceId, inboundEmail({ from: "two@customer.example" }));
    expect(noticesIn(seat.calls)).toEqual([]);
  });

  it("opens up again the next hour", async () => {
    const seat = await desk();
    for (let sent = 0; sent < 7; sent++) await recordInboundMail(seat.services, seat.workspaceId, inboundEmail());
    const { services: nextHour, calls } = mailingServices(db, [RESEND_BATCH], new Date(NOW.getTime() + 3_600_000));
    await recordInboundMail(nextHour, seat.workspaceId, inboundEmail());
    expect(noticesIn(calls)).toHaveLength(2);
  });

  it("counts nothing when there's nobody to tell", async () => {
    const seat = await desk();
    await saveNoticePreference(db, seat.workspaceId, seat.userId, false, []);
    await saveNoticePreference(db, seat.workspaceId, seat.bea.userId, false, []);
    for (let sent = 0; sent < 8; sent++) await recordInboundMail(seat.services, seat.workspaceId, inboundEmail());
    await saveNoticePreference(db, seat.workspaceId, seat.userId, true, [seat.product.id]);
    await recordInboundMail(seat.services, seat.workspaceId, inboundEmail());
    expect(noticesIn(seat.calls)).toHaveLength(1);
  });
});

describe("a notification that fails", () => {
  const DOWN = { match: "POST https://api.resend.com/emails/batch", status: 500, json: { message: "Down" } };

  it("loses nothing: an app's ticket opens, and the failure is on it for the team", async () => {
    const seat = await desk([DOWN, RESEND_DOMAINS]);
    const { number } = await openFromApp(seat);
    expect((await ticketForTeam(db, seat.workspaceId, number))?.messages.map(({ kind }) => kind)).toEqual(["customer", "system"]);
    expect((await systemLines(seat.workspaceId, number))[0]).toContain("The team couldn’t be mailed about this");
  });

  it("loses nothing from the form, from email, or from the requester's page", async () => {
    const seat = await desk([DOWN, RESEND_DOMAINS]);
    expect(await receivePublicForm(seat.services, { key: seat.product.publicKey, email: "dee@customer.example", subject: "Form", message: "Hello" }, "203.0.113.1")).toMatchObject({ status: 201, number: 1 });
    expect(await recordInboundMail(seat.services, seat.workspaceId, inboundEmail())).toBe("opened");
    const { requesterUrl, number } = await openFromApp(seat);
    expect(await answerAsRequester(seat.services, tokenOf(requesterUrl), "More.")).toMatchObject({ ok: true });
    expect((await ticketForTeam(db, seat.workspaceId, number))?.messages.some(({ body }) => body === "More.")).toBe(true);
  });

  it("is never shown to the requester", async () => {
    const seat = await desk([DOWN, RESEND_DOMAINS]);
    const { requesterUrl } = await openFromApp(seat);
    expect(JSON.stringify(await seeAsRequester(seat.services, tokenOf(requesterUrl)))).not.toContain("couldn’t be mailed");
  });

  it("is survived when the network itself fails, or hangs", async () => {
    const seat = await desk();
    const down = { ...seat.services, fetch: (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch };
    const created = await openTicket(down, seat.workspaceId);
    expect((await systemLines(seat.workspaceId, created.number))[0]).toContain("fetch failed");
  });

  it("is bounded in time: a provider that hangs can't hold the request", async () => {
    const seat = await desk();
    const seen: (AbortSignal | null | undefined)[] = [];
    const watching = { ...seat.services, fetch: (async (_: unknown, init: RequestInit) => { seen.push(init.signal); return new Response(JSON.stringify({ data: [] })); }) as typeof fetch };
    await openTicket(watching, seat.workspaceId);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it("is survived even when the failure can't be written down", async () => {
    const seat = await desk();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const notice: TeamNotice = { kind: "new_ticket", ticket: { id: crypto.randomUUID(), number: 1, subject: "A", productId: null, assigneeId: null }, writer: { contactId: crypto.randomUUID(), email: "x@y.example" }, words: "B" };
    const broken = { ...seat.services, db: { transaction: () => Promise.reject(new Error("The database is gone")), select: () => { throw new Error("The database is gone"); } } as never };
    await expect(notifyTeam(broken, seat.workspaceId, notice)).resolves.toMatchObject({ status: "failed" });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("is said on the screen in the service's words", async () => {
    const seat = await desk([{ match: "POST https://api.resend.com/emails/batch", status: 403, json: { message: "The example.test domain is not verified." } }, RESEND_DOMAINS]);
    const { number } = await openFromApp(seat);
    expect((await systemLines(seat.workspaceId, number))[0]).toContain("The example.test domain is not verified.");
  });
});

describe("an instance with no mail", () => {
  it("tells nobody, reads nothing, and still takes the ticket", async () => {
    const seat = await desk();
    const silent = { ...seat.services, settings: { ...seat.services.settings, RESEND_API_KEY: undefined } };
    const { number } = await openTicket(silent, seat.workspaceId);
    expect(noticesIn(seat.calls)).toEqual([]);
    expect(await systemLines(seat.workspaceId, number)).toEqual([]);
    const unplugged = { ...silent, db: { transaction: () => { throw new Error("The database was asked."); } } as never };
    await expect(notifyTeam(unplugged, seat.workspaceId, { kind: "new_ticket", ticket: { id: "t", number: 1, subject: "A", productId: null, assigneeId: null }, writer: { contactId: "c", email: "x@y.example" }, words: "B" })).resolves.toEqual({ status: "no_mail" });
  });
});
