import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { addNote } from "@/application/conversation";
import { recordInboundMail } from "@/application/inbound-mail";
import { HOUR_LIMITS } from "@/application/rate-limit";
import { replyNow, saveDraft } from "@/application/replies";
import { requesterUrlOf } from "@/application/requester-links";
import { answerAsRequester, requesterMaySee, seeAsRequester } from "@/application/requester";
import { ticketForTeam } from "@/application/ticket-queries";
import { endRequesterLinks, updateTicket } from "@/application/tickets";
import { issueRequesterToken, readRequesterToken } from "@/infrastructure/crypto/requester-token";
import type { Database } from "@/infrastructure/db/client";
import { ticket } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { addProduct, AUTH_SECRET, connectResend, inboundEmail, NOW, openTicket, RESEND_DOMAINS, testServices } from "./support/desk";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const TICKET = "22222222-2222-4222-8222-222222222222";
const LATER = new Date(NOW.getTime() + 86_400_000);

describe("a requester's token", () => {
  const claims = { workspaceId: WORKSPACE, ticketId: TICKET, version: 3, expiresAt: LATER };
  const token = issueRequesterToken(claims, AUTH_SECRET);

  it("says which ticket, in which workspace, until when", () => {
    expect(readRequesterToken(token, AUTH_SECRET, NOW)).toEqual({ valid: true, claims });
  });

  it("is short enough for a link, and URL-safe", () => {
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(token.length).toBeLessThan(100);
  });

  it("stops at its end", () => {
    expect(readRequesterToken(token, AUTH_SECRET, LATER)).toEqual({ valid: false, why: "expired" });
  });

  it("is refused signed with another secret", () => {
    expect(readRequesterToken(issueRequesterToken(claims, "another-secret-of-the-same-sort"), AUTH_SECRET, NOW)).toEqual({ valid: false, why: "invalid" });
  });

  it("is refused with any character of it changed", () => {
    const [payload, signature] = token.split(".");
    const flip = (text: string, at: number) => `${text.slice(0, at)}${text[at] === "A" ? "B" : "A"}${text.slice(at + 1)}`;
    for (const at of [0, 10, 20, payload.length - 1]) expect(readRequesterToken(`${flip(payload, at)}.${signature}`, AUTH_SECRET, NOW)).toEqual({ valid: false, why: "invalid" });
    expect(readRequesterToken(`${payload}.${flip(signature, 0)}`, AUTH_SECRET, NOW)).toEqual({ valid: false, why: "invalid" });
  });

  it.each(["", "garbage", ".", "a.b", "a.b.c", `${"A".repeat(10)}.${"B".repeat(27)}`])("is refused as %j", (given) => {
    expect(readRequesterToken(given, AUTH_SECRET, NOW)).toEqual({ valid: false, why: "invalid" });
  });

  it("can't have another ticket's id spliced into it", () => {
    const other = issueRequesterToken({ ...claims, ticketId: "33333333-3333-4333-8333-333333333333" }, AUTH_SECRET);
    expect(readRequesterToken(`${other.split(".")[0]}.${token.split(".")[1]}`, AUTH_SECRET, NOW)).toEqual({ valid: false, why: "invalid" });
  });
});

async function desk() {
  const { workspaceId, userId } = await createTestWorkspace(db);
  const { services, calls } = testServices(db);
  const product = await addProduct(db, workspaceId, userId);
  await connectResend(services, workspaceId, userId);
  const { number, requesterUrl } = await openTicket(services, workspaceId, { product: product.slug });
  return { workspaceId, userId, services, calls, number, token: new URL(requesterUrl).pathname.split("/t/")[1], actor: { userId, writtenBy: "member" as const } };
}

const seenBodies = async (services: Parameters<typeof seeAsRequester>[0], token: string) => {
  const seen = await seeAsRequester(services, token);
  if (seen.status !== "open") throw new Error(seen.status);
  return seen.ticket.messages.map(({ body }) => body);
};

describe("what a requester sees", () => {
  it("is their own words and the replies that left, in order, with nothing about the team", async () => {
    const { workspaceId, services, number, token, actor } = await desk();
    await replyNow(services, workspaceId, number, "We’re on it.", actor);
    const seen = await seeAsRequester(services, token);
    if (seen.status !== "open") throw new Error(seen.status);
    expect(seen.ticket).toMatchObject({ number, subject: "It broke", status: "pending", productName: "Acme App" });
    expect(seen.ticket.messages.map(({ from, body }) => [from, body])).toEqual([
      ["you", "Nothing works since this morning."],
      ["support", "We’re on it."],
    ]);
    const shown = JSON.stringify(seen);
    for (const hidden of ["assignee", "tags", "priority", "context", "category", "authorUserId", "deliveryState", actor.userId]) expect(shown).not.toContain(hidden);
  });

  it("never holds an internal note", async () => {
    const { workspaceId, services, number, token, actor } = await desk();
    await addNote(services, workspaceId, number, "SECRET: this customer is a known fraudster", actor);
    await addNote(services, workspaceId, number, "SECRET too", { ...actor, writtenBy: "assistant" });
    expect(JSON.stringify(await seeAsRequester(services, token))).not.toContain("SECRET");
  });

  it("never holds a draft", async () => {
    const { workspaceId, services, number, token, actor } = await desk();
    await saveDraft(db, workspaceId, number, "DRAFT: not decided yet", actor);
    expect(JSON.stringify(await seeAsRequester(services, token))).not.toContain("DRAFT");
  });

  it("never holds a system line, like who it was assigned to", async () => {
    const { workspaceId, services, number, token, actor } = await desk();
    await updateTicket(services, workspaceId, number, { assigneeId: actor.userId, priority: "urgent" }, actor);
    expect(await seenBodies(services, token)).toEqual(["Nothing works since this morning."]);
  });

  it("never holds a reply that failed, which may yet be reworded", async () => {
    const { workspaceId, userId, number, token } = await desk();
    const { services: broken } = testServices(db, [RESEND_DOMAINS, { match: "POST https://api.resend.com/emails", status: 500, json: { message: "Down" } }]);
    await replyNow(broken, workspaceId, number, "FAILED words", { userId, writtenBy: "member" });
    expect(JSON.stringify(await seeAsRequester(broken, token))).not.toContain("FAILED");
  });

  it("never holds what someone else wrote on their ticket by mail", async () => {
    const { workspaceId, services, number, token } = await desk();
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(ticket).where(eq(ticket.number, number)));
    await recordInboundMail(services, workspaceId, inboundEmail({ from: "stranger@elsewhere.example", addressedTo: [`support+${row.replyToken}@acme.example`], text: "STRANGER wrote this" }));
    expect((await ticketForTeam(db, workspaceId, number))?.messages.at(-1)?.body).toContain("STRANGER");
    expect(JSON.stringify(await seeAsRequester(services, token))).not.toContain("STRANGER");
  });

  it("decides by a list: a kind or a state nobody thought of stays hidden", () => {
    const contact = "c1";
    expect(requesterMaySee({ kind: "customer", deliveryState: null, authorContactId: contact }, contact)).toBe(true);
    expect(requesterMaySee({ kind: "customer", deliveryState: null, authorContactId: "c2" }, contact)).toBe(false);
    for (const deliveryState of ["sent", "delivered", "delayed", "bounced", "complained"] as const) expect(requesterMaySee({ kind: "agent", deliveryState, authorContactId: null }, contact)).toBe(true);
    for (const deliveryState of ["draft", "sending", "failed", null] as const) expect(requesterMaySee({ kind: "agent", deliveryState, authorContactId: null }, contact)).toBe(false);
    expect(requesterMaySee({ kind: "note", deliveryState: null, authorContactId: null }, contact)).toBe(false);
    expect(requesterMaySee({ kind: "system", deliveryState: null, authorContactId: null }, contact)).toBe(false);
    expect(requesterMaySee({ kind: "something-new" as never, deliveryState: "sent", authorContactId: contact }, contact)).toBe(false);
  });

  it("isn't mailed a note: only replies leave", async () => {
    const { workspaceId, services, calls, number, actor } = await desk();
    await addNote(services, workspaceId, number, "SECRET", actor);
    await replyNow(services, workspaceId, number, "Hello", actor);
    const mails = calls.filter(({ method, url }) => method === "POST" && url.endsWith("/emails"));
    expect(mails).toHaveLength(1);
    expect(mails[0].body).not.toContain("SECRET");
  });
});

describe("a link", () => {
  it("is refused when forged, without asking the database", async () => {
    const { services } = testServices({ select: () => { throw new Error("The database was asked."); }, transaction: () => { throw new Error("The database was asked."); } } as never);
    expect(await seeAsRequester(services, "garbage.token")).toEqual({ status: "invalid" });
    expect((await answerAsRequester(services, "garbage.token", "Hello")).ok).toBe(false);
  });

  it("says when it has expired, past 90 days", async () => {
    const { workspaceId, number, token } = await desk();
    const { services: muchLater } = testServices(db, [], new Date(NOW.getTime() + 91 * 86_400_000));
    expect(await seeAsRequester(muchLater, token)).toEqual({ status: "expired" });
    expect(await answerAsRequester(muchLater, token, "Hello")).toEqual({ ok: false, error: expect.stringContaining("expired") });
    expect((await ticketForTeam(db, workspaceId, number))?.messages).toHaveLength(1);
  });

  it("stops working once a member ends the ticket's links, and the next one works", async () => {
    const { workspaceId, services, number, token } = await desk();
    expect(await endRequesterLinks(db, workspaceId, number)).toBe(true);
    expect(await seeAsRequester(services, token)).toEqual({ status: "invalid" });
    expect((await answerAsRequester(services, token, "Hello")).ok).toBe(false);
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(ticket).where(eq(ticket.number, number)));
    const fresh = new URL(requesterUrlOf(services, row)).pathname.split("/t/")[1];
    expect((await seeAsRequester(services, fresh)).status).toBe("open");
  });

  it("is refused once its ticket is gone", async () => {
    const { workspaceId, services, number, token } = await desk();
    await withWorkspace(db, workspaceId, (tx) => tx.delete(ticket).where(eq(ticket.number, number)));
    expect(await seeAsRequester(services, token)).toEqual({ status: "invalid" });
  });

  it("opens one ticket only: another's in the same workspace needs its own", async () => {
    const { workspaceId, services, number, token } = await desk();
    const other = await openTicket(services, workspaceId, { subject: "Someone else’s", requester: { email: "bea@customer.example" } });
    const seen = await seeAsRequester(services, token);
    expect(JSON.stringify(seen)).not.toContain("Someone else");
    expect(seen).toMatchObject({ ticket: { number } });
    expect(other.number).not.toBe(number);
  });

  it("can't reach into another workspace by naming it: the workspace in the token is signed", async () => {
    const { workspaceId, services, number, token } = await desk();
    const elsewhere = await createTestWorkspace(db, "Elsewhere");
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(ticket).where(eq(ticket.number, number)));
    const crossed = issueRequesterToken({ workspaceId: elsewhere.workspaceId, ticketId: row.id, version: row.linkVersion, expiresAt: LATER }, AUTH_SECRET);
    expect(await seeAsRequester(services, crossed)).toEqual({ status: "invalid" });
    expect((await seeAsRequester(services, token)).status).toBe("open");
  });
});

describe("a requester answering", () => {
  it("adds to the conversation as them, and puts the ticket back with support", async () => {
    const { workspaceId, services, number, token, actor } = await desk();
    await replyNow(services, workspaceId, number, "Which browser?", actor);
    expect(await answerAsRequester(services, token, "  Firefox.  ")).toEqual({ ok: true, said: "Your answer was added to the conversation." });
    const team = await ticketForTeam(db, workspaceId, number);
    expect(team?.ticket.status).toBe("open");
    expect(team?.messages.at(-1)).toMatchObject({ kind: "customer", body: "Firefox.", authorContactId: team?.contact.id });
    expect(await seenBodies(services, token)).toContain("Firefox.");
  });

  it("reopens a closed ticket, and clears when it was resolved", async () => {
    const { workspaceId, services, number, token, actor } = await desk();
    await updateTicket(services, workspaceId, number, { status: "closed" }, actor);
    await answerAsRequester(services, token, "It’s back.");
    const team = await ticketForTeam(db, workspaceId, number);
    expect(team?.ticket).toMatchObject({ status: "open", resolvedAt: null });
    expect(team?.messages.at(-1)).toMatchObject({ kind: "system", body: expect.stringContaining("Reopened") });
  });

  it("refuses an empty answer, or one too long", async () => {
    const { services, token } = await desk();
    expect((await answerAsRequester(services, token, "   ")).ok).toBe(false);
    expect((await answerAsRequester(services, token, "x".repeat(20_001))).ok).toBe(false);
  });

  it("is limited per hour, and open again the next hour", async () => {
    const { workspaceId, services, number, token } = await desk();
    for (let sent = 0; sent < HOUR_LIMITS.requesterAnswers; sent++) expect((await answerAsRequester(services, token, `Message ${sent}`)).ok).toBe(true);
    const refused = await answerAsRequester(services, token, "One too many");
    expect(refused).toEqual({ ok: false, error: expect.stringContaining("try again later") });
    expect(JSON.stringify((await ticketForTeam(db, workspaceId, number))?.messages)).not.toContain("One too many");
    const { services: nextHour } = testServices(db, [], new Date(NOW.getTime() + 3_600_000));
    expect((await answerAsRequester(nextHour, token, "Later")).ok).toBe(true);
  });
});
