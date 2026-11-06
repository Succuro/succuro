import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { receiveHook, recordInboundMail } from "@/application/inbound-mail";
import { recordDeliveryReport } from "@/application/delivery-reports";
import { replyNow } from "@/application/replies";
import { listTickets, ticketForTeam } from "@/application/ticket-queries";
import { updateTicket } from "@/application/tickets";
import { isAutomatedMail } from "@/domain/email";
import type { Database } from "@/infrastructure/db/client";
import { connection } from "@/infrastructure/db/schema/connections";
import { ticket } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { addProduct, connectResend, inboundEmail, openTicket, RESEND_DOMAINS, RESEND_SENDS, signedRequest } from "./support/desk";
import type { FakeRoute } from "./support/fetch";
import { addTeammate, mailingServices, noticesIn, RESEND_BATCH } from "./support/notices";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

async function desk(extraRoutes: FakeRoute[] = []) {
  const { workspaceId, userId } = await createTestWorkspace(db);
  const { services, calls } = mailingServices(db, [RESEND_BATCH, RESEND_DOMAINS, RESEND_SENDS, ...extraRoutes]);
  const product = await addProduct(db, workspaceId, userId);
  await addTeammate(db, workspaceId);
  const connected = await connectResend(services, workspaceId, userId);
  calls.length = 0;
  return { workspaceId, userId, services, calls, product, connectionId: connected.id, actor: { userId, writtenBy: "member" as const } };
}

/** Anything that left: a reply, a notification, anything at all. */
const everythingSent = (calls: { method: string }[]) => calls.filter(({ method }) => method === "POST");
const ticketsOf = async (workspaceId: string) => (await listTickets(db, workspaceId, {})).tickets;
const row = async (workspaceId: string, number: number) => (await withWorkspace(db, workspaceId, (tx) => tx.select().from(ticket).where(eq(ticket.number, number))))[0];

const MACHINES: [string, Parameters<typeof inboundEmail>[0]][] = [
  ["Auto-Submitted: auto-replied", { headers: { "auto-submitted": "auto-replied" } }],
  ["Auto-Submitted: auto-generated", { headers: { "auto-submitted": "auto-generated" } }],
  ["Auto-Submitted with a parameter", { headers: { "auto-submitted": "auto-replied; owner-email=ada@customer.example" } }],
  ["Precedence: bulk", { headers: { precedence: "bulk" } }],
  ["Precedence: BULK", { headers: { precedence: "BULK" } }],
  ["Precedence: junk", { headers: { precedence: "junk" } }],
  ["Precedence: list", { headers: { precedence: "list" } }],
  ["Precedence: auto_reply", { headers: { precedence: "auto_reply" } }],
  ["X-Autoreply", { headers: { "x-autoreply": "yes" } }],
  ["X-Autorespond", { headers: { "x-autorespond": "yes" } }],
  ["X-Auto-Response-Suppress", { headers: { "x-auto-response-suppress": "All" } }],
  ["List-Id", { headers: { "list-id": "<news.acme.example>" } }],
  ["X-Failed-Recipients", { headers: { "x-failed-recipients": "ada@customer.example" } }],
  ["an empty Return-Path", { headers: { "return-path": "<>" } }],
  ["a delivery report", { headers: { "content-type": 'multipart/report; report-type=delivery-status; boundary="x"' } }],
  ["a mailer-daemon sender", { from: "mailer-daemon@mx.customer.example" }],
  ["a postmaster sender", { from: "postmaster@customer.example" }],
  ["a mail-daemon sender", { from: "mail-daemon@customer.example" }],
];

describe("a machine's mail that answers nothing", () => {
  it.each(MACHINES)("with %s opens no ticket, and sends nothing", async (_, overrides) => {
    const { workspaceId, services, calls } = await desk();
    expect(await recordInboundMail(services, workspaceId, inboundEmail(overrides))).toBe("screened");
    expect(await ticketsOf(workspaceId)).toEqual([]);
    expect(everythingSent(calls)).toEqual([]);
  });

  it("opens nothing however many come", async () => {
    const { workspaceId, services, calls } = await desk();
    for (let sent = 0; sent < 25; sent++) expect(await recordInboundMail(services, workspaceId, inboundEmail({ headers: { "auto-submitted": "auto-replied" }, subject: `Out of office ${sent}` }))).toBe("screened");
    expect(await ticketsOf(workspaceId)).toEqual([]);
    expect(everythingSent(calls)).toEqual([]);
  });

  it("isn't mistaken for a person's, who may mention the same words", () => {
    expect(isAutomatedMail({}, "ada@customer.example")).toBe(false);
    expect(isAutomatedMail({ "auto-submitted": "no" }, "ada@customer.example")).toBe(false);
    expect(isAutomatedMail({ precedence: "first-class" }, "ada@customer.example")).toBe(false);
    expect(isAutomatedMail({ "content-type": "text/plain" }, "ada@customer.example")).toBe(false);
    expect(isAutomatedMail({ "return-path": "<ada@customer.example>" }, "ada@customer.example")).toBe(false);
    expect(isAutomatedMail({}, "postmaster.fan@customer.example")).toBe(false);
  });
});

describe("a machine's mail on a ticket", () => {
  it.each(MACHINES)("with %s is noted for the team: no reopening, no answer, no notification", async (_, overrides) => {
    const { workspaceId, services, calls, actor, product } = await desk();
    const { number } = await openTicket(services, workspaceId, { product: product.slug });
    const { replyToken } = await row(workspaceId, number);
    await updateTicket(services, workspaceId, number, { status: "resolved" }, actor);
    const before = await row(workspaceId, number);
    calls.length = 0;
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ ...overrides, addressedTo: [`support+${replyToken}@acme.example`] }))).toBe("noted");
    expect(await row(workspaceId, number)).toMatchObject({ status: "resolved", lastMessageAt: before.lastMessageAt, resolvedAt: before.resolvedAt });
    expect((await ticketForTeam(db, workspaceId, number))?.messages.at(-1)?.kind).toBe("system");
    expect(everythingSent(calls)).toEqual([]);
  });
});

describe("a reply and what answers it", () => {
  it("stops at the out-of-office: nothing goes back, however long it goes on", async () => {
    const { workspaceId, services, calls, actor, product } = await desk();
    const { number } = await openTicket(services, workspaceId, { product: product.slug });
    await replyNow(services, workspaceId, number, "We’re on it.", actor);
    const sentMail = () => calls.filter(({ method, url }) => method === "POST" && url.endsWith("/emails"));
    expect(sentMail()).toHaveLength(1);
    await recordDeliveryReport(services, workspaceId, { providerId: "resend-sent-1", outcome: "sent", messageId: "<ours@acme.example>", detail: null });
    calls.length = 0;
    for (let round = 0; round < 10; round++) expect(await recordInboundMail(services, workspaceId, inboundEmail({ inReplyTo: "<ours@acme.example>", headers: { "auto-submitted": "auto-replied" }, text: "I’m away." }))).toBe("noted");
    expect(everythingSent(calls)).toEqual([]);
    expect((await row(workspaceId, number)).status).toBe("pending");
  });

  it("stops at a bounce too", async () => {
    const { workspaceId, services, calls, actor, product } = await desk();
    const { number } = await openTicket(services, workspaceId, { product: product.slug });
    await replyNow(services, workspaceId, number, "We’re on it.", actor);
    await recordDeliveryReport(services, workspaceId, { providerId: "resend-sent-1", outcome: "sent", messageId: "<ours@acme.example>", detail: null });
    calls.length = 0;
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ from: "mailer-daemon@mx.customer.example", inReplyTo: "<ours@acme.example>", headers: { "x-failed-recipients": "ada@customer.example" }, text: "Delivery failed." }))).toBe("noted");
    expect(everythingSent(calls)).toEqual([]);
    expect((await listTickets(db, workspaceId, { status: "pending" })).tickets).toHaveLength(1);
    expect((await row(workspaceId, number)).status).toBe("pending");
  });

  it("gets nothing back when a robot with no such headers keeps writing: tickets, yes, but no mail to it, and the team hears only so much", async () => {
    const { workspaceId, services, calls } = await desk();
    for (let round = 0; round < 12; round++) await recordInboundMail(services, workspaceId, inboundEmail({ from: "robot@elsewhere.example", subject: `Automatic ${round}` }));
    expect(calls.filter(({ method, url }) => method === "POST" && url.endsWith("/emails"))).toEqual([]);
    expect(noticesIn(calls).every(({ to }) => !to.includes("robot@elsewhere.example"))).toBe(true);
    expect(noticesIn(calls)).toHaveLength(10);
  });
});

describe("our own mail coming back", () => {
  it("waits in Screened from a product's address, with or without a token, and opens nothing", async () => {
    const { workspaceId, services, calls } = await desk();
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ from: "support@acme.example" }))).toBe("screened");
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ from: "support+abc@acme.example" }))).toBe("screened");
    expect(await ticketsOf(workspaceId)).toEqual([]);
    expect(everythingSent(calls)).toEqual([]);
  });

  it("is ignored from the instance's own address: a notification sent to a team address that is a support address opens no ticket", async () => {
    const { workspaceId, services, calls } = await desk();
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ from: "no-reply@succuro.test", subject: "[Acme App #1] New ticket: A", headers: {} }))).toBe("ignored");
    expect(await ticketsOf(workspaceId)).toEqual([]);
    expect(everythingSent(calls)).toEqual([]);
  });

  it("is recognised by its own headers even when it's been forwarded from somewhere else", async () => {
    const { workspaceId, services, calls } = await desk();
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ from: "forwarder@elsewhere.example", headers: { "auto-submitted": "auto-generated", "x-auto-response-suppress": "All" } }))).toBe("screened");
    expect(everythingSent(calls)).toEqual([]);
  });

  it("gets no notification out of a notification, end to end", async () => {
    const { workspaceId, services, calls, product } = await desk();
    await openTicket(services, workspaceId, { product: product.slug });
    const [notice] = noticesIn(calls);
    calls.length = 0;
    const echo = inboundEmail({ from: "no-reply@succuro.test", addressedTo: notice.to, subject: notice.subject, text: notice.text, headers: { "auto-submitted": notice.headers["Auto-Submitted"].toLowerCase() } });
    expect(await recordInboundMail(services, workspaceId, echo)).toBe("ignored");
    expect(everythingSent(calls)).toEqual([]);
    expect(await ticketsOf(workspaceId)).toHaveLength(1);
  });
});

describe("through the webhook itself", () => {
  const RECEIVED = (id: string) => JSON.stringify({ type: "email.received", data: { email_id: id, from: "x", to: ["support@acme.example"] } });
  const mail = (id: string, headers: Record<string, string>, from = "ada@customer.example"): FakeRoute => ({ match: `GET https://api.resend.com/emails/receiving/${id}`, json: { id, from, to: ["support@acme.example"], subject: "Out of office", text: "I’m away.", headers, message_id: `<${id}@customer.example>` } });

  async function hooked(routes: FakeRoute[]) {
    const seat = await desk(routes);
    const [row] = await withWorkspace(db, seat.workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, seat.connectionId)));
    return { ...seat, token: row.hookToken };
  }

  it.each([
    ["Auto-Submitted, as Resend hands the headers over", mail("a1", { "Auto-Submitted": "auto-replied" }), "a1"],
    ["Precedence: bulk", mail("a2", { Precedence: "bulk" }), "a2"],
    ["a mailer-daemon, with a display name", mail("a3", { From: "Mail Delivery System <MAILER-DAEMON@mx.customer.example>" }, "MAILER-DAEMON@mx.customer.example"), "a3"],
  ])("takes %s in, and nothing comes of it", async (_, route, id) => {
    const { workspaceId, services, calls, connectionId, token } = await hooked([route]);
    expect(await receiveHook(services, connectionId, token, signedRequest(RECEIVED(id), { id: `msg_${id}` }))).toEqual({ status: 200, body: "screened" });
    expect(await ticketsOf(workspaceId)).toEqual([]);
    expect(everythingSent(calls)).toEqual([]);
  });
});
