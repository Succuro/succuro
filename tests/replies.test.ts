import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { recordDeliveryReport } from "@/application/delivery-reports";
import { recordInboundMail } from "@/application/inbound-mail";
import { APPROVE_FIRST, discardDraft, replyNow, saveDraft, sendReply, sendReplyAsAssistant } from "@/application/replies";
import { ticketForTeam } from "@/application/ticket-queries";
import { setAssistantMaySend, settingsOf } from "@/application/workspace-settings";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { connection } from "@/infrastructure/db/schema/connections";
import { ticket } from "@/infrastructure/db/schema/support";
import { member } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { SCHEDULED_WORK_TAG } from "@/infrastructure/scheduling/scheduled-work";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { addProduct, connectResend, inboundEmail, NOW, openTicket, RESEND_DOMAINS, RESEND_SENDS, testServices } from "./support/desk";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

async function desk(routes = [RESEND_DOMAINS, RESEND_SENDS]) {
  const { workspaceId, userId } = await createTestWorkspace(db);
  const { services, calls } = testServices(db, routes);
  const product = await addProduct(db, workspaceId, userId);
  await connectResend(services, workspaceId, userId);
  const { number } = await openTicket(services, workspaceId, { product: product.slug });
  return { workspaceId, userId, services, calls, number, actor: { userId, writtenBy: "member" as const } };
}

const sends = (calls: { method: string; url: string; body: string; headers: Headers }[]) => calls.filter(({ method, url }) => method === "POST" && url === "https://api.resend.com/emails");
const ticketRow = async (workspaceId: string, number: number) => (await withWorkspace(db, workspaceId, (tx) => tx.select().from(ticket).where(eq(ticket.number, number))))[0];
const lastMessage = async (workspaceId: string, number: number) => (await ticketForTeam(db, workspaceId, number))?.messages.at(-1);

describe("sending a reply", () => {
  it("emails the requester from the product's address, answers to the ticket's token, and carries their link", async () => {
    const { workspaceId, services, calls, number, actor } = await desk();
    expect(await replyNow(services, workspaceId, number, "We’re on it.", actor)).toEqual({ ok: true, said: "Sent to ada@customer.example." });
    const [mail] = sends(calls);
    const sent = JSON.parse(mail.body);
    const { replyToken } = await ticketRow(workspaceId, number);
    expect(sent).toMatchObject({ from: "Acme App support <support@acme.example>", to: ["ada@customer.example"], reply_to: `support+${replyToken}@acme.example`, subject: "Re: It broke" });
    expect(sent.text).toContain("We’re on it.");
    expect(sent.text).toMatch(/https:\/\/succuro\.test\/t\/[\w-]+\.[\w-]+/);
    expect(mail.headers.get("idempotency-key")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses the workspace's own key, never the instance's", async () => {
    const { workspaceId, services, calls, number, actor } = await desk();
    await replyNow({ ...services, settings: { ...services.settings, RESEND_API_KEY: "re_instance_key" } }, workspaceId, number, "Hello", actor);
    expect(sends(calls)[0].headers.get("authorization")).toBe("Bearer re_test_key");
  });

  it("threads on what came before", async () => {
    const { workspaceId, services, calls, number, actor } = await desk();
    const { replyToken } = await ticketRow(workspaceId, number);
    await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: [`support+${replyToken}@acme.example`], messageId: "<first@customer.example>" }));
    await replyNow(services, workspaceId, number, "First answer", actor);
    await recordDeliveryReport(services, workspaceId, { providerId: "resend-sent-1", outcome: "sent", messageId: "<ours@acme.example>", detail: null });
    await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: [`support+${replyToken}@acme.example`], messageId: "<second@customer.example>", inReplyTo: "<ours@acme.example>" }));
    await replyNow({ ...services, fetch: testServices(db, [{ match: "POST https://api.resend.com/emails", json: { id: "resend-sent-2" } }]).services.fetch }, workspaceId, number, "Second answer", actor);
    expect(JSON.parse(sends(calls)[0].body).headers).toEqual({ "In-Reply-To": "<first@customer.example>", References: "<first@customer.example>" });
  });

  it("threads a second answer on everything before it", async () => {
    const { workspaceId, services, calls, number, actor } = await desk();
    const { replyToken } = await ticketRow(workspaceId, number);
    await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: [`support+${replyToken}@acme.example`], messageId: "<first@customer.example>" }));
    await withWorkspace(db, workspaceId, (tx) => tx.select().from(ticket));
    await replyNow(services, workspaceId, number, "First answer", actor);
    await recordDeliveryReport(services, workspaceId, { providerId: "resend-sent-1", outcome: "sent", messageId: "<ours@acme.example>", detail: null });
    const { services: second, calls: secondCalls } = testServices(db, [{ match: "POST https://api.resend.com/emails", json: { id: "resend-sent-2" } }]);
    await replyNow(second, workspaceId, number, "Second answer", actor);
    expect(sends(calls)).toHaveLength(1);
    expect(JSON.parse(sends(secondCalls)[0].body).headers).toEqual({ "In-Reply-To": "<ours@acme.example>", References: "<first@customer.example> <ours@acme.example>" });
  });

  it("marks it sent, records the first response once, and leaves the ticket waiting on the requester", async () => {
    const { workspaceId, services, number, actor } = await desk();
    await replyNow(services, workspaceId, number, "Hello", actor);
    expect(await lastMessage(workspaceId, number)).toMatchObject({ kind: "agent", deliveryState: "sent", providerId: "resend-sent-1", writtenBy: "member", authorUserId: actor.userId });
    expect(await ticketRow(workspaceId, number)).toMatchObject({ status: "pending", firstResponseAt: NOW, lastMessageAt: NOW });
    const later = new Date(NOW.getTime() + 60_000);
    const { services: laterServices } = testServices(db, [{ match: "POST https://api.resend.com/emails", json: { id: "resend-sent-3" } }], later);
    await replyNow(laterServices, workspaceId, number, "Again", actor);
    expect(await ticketRow(workspaceId, number)).toMatchObject({ firstResponseAt: NOW, lastMessageAt: later });
  });

  it("can settle the ticket as it goes", async () => {
    const { workspaceId, services, number, actor } = await desk();
    await replyNow(services, workspaceId, number, "Solved.", actor, "resolved");
    expect(await ticketRow(workspaceId, number)).toMatchObject({ status: "resolved", resolvedAt: NOW });
  });

  it("clears what's known about scheduled work before it sends, so the job can catch a send that dies", async () => {
    const { workspaceId, services, number, actor } = await desk();
    revalidateTag.mockClear();
    await replyNow(services, workspaceId, number, "Hello", actor);
    expect(revalidateTag).toHaveBeenCalledWith(SCHEDULED_WORK_TAG, { expire: 0 });
  });
});

describe("a reply that doesn't leave", () => {
  it("keeps its words and says why when the service refuses, and the ticket doesn't move", async () => {
    const { workspaceId, services, number, actor } = await desk([RESEND_DOMAINS, { match: "POST https://api.resend.com/emails", status: 422, json: { message: "The acme.example domain is not verified." } }]);
    const sent = await replyNow(services, workspaceId, number, "Hello", actor);
    expect(sent).toEqual({ ok: false, error: expect.stringContaining("The acme.example domain is not verified.") });
    expect(await lastMessage(workspaceId, number)).toMatchObject({ body: "Hello", deliveryState: "failed", deliveryError: expect.stringContaining("not verified") });
    expect(await ticketRow(workspaceId, number)).toMatchObject({ status: "open", firstResponseAt: null });
  });

  it("marks the connection failing when the key itself is refused", async () => {
    const { workspaceId, services, number, actor } = await desk([RESEND_DOMAINS, { match: "POST https://api.resend.com/emails", status: 401, json: { message: "API key is invalid" } }]);
    await replyNow(services, workspaceId, number, "Hello", actor);
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection));
    expect(row).toMatchObject({ status: "failing", lastError: expect.stringContaining("API key is invalid") });
  });

  it("says so when no service is connected", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = testServices(db);
    const product = await addProduct(db, workspaceId, userId);
    const { number } = await openTicket(services, workspaceId, { product: product.slug });
    expect(await replyNow(services, workspaceId, number, "Hello", { userId, writtenBy: "member" })).toEqual({ ok: false, error: expect.stringContaining("No mail service is connected") });
  });

  it("says so when the ticket has no product to answer from", async () => {
    const { workspaceId, services, actor } = await desk();
    const { number } = await openTicket(services, workspaceId);
    expect(await replyNow(services, workspaceId, number, "Hello", actor)).toEqual({ ok: false, error: expect.stringContaining("no product") });
  });

  it("says so when the product has no address", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = testServices(db);
    const product = await addProduct(db, workspaceId, userId, "Bare", "");
    await connectResend(services, workspaceId, userId);
    const { number } = await openTicket(services, workspaceId, { product: product.slug });
    expect(await replyNow(services, workspaceId, number, "Hello", { userId, writtenBy: "member" })).toEqual({ ok: false, error: expect.stringContaining("Bare has no support address") });
  });

  it("refuses an empty one, and one for a ticket that isn't here, recording nothing", async () => {
    const { workspaceId, services, number, actor } = await desk();
    expect((await replyNow(services, workspaceId, number, "   ", actor)).ok).toBe(false);
    expect((await replyNow(services, workspaceId, 999, "Hello", actor)).ok).toBe(false);
    expect((await ticketForTeam(db, workspaceId, number))?.messages).toHaveLength(1);
  });

  it("can be sent again, edited, once the trouble's over", async () => {
    const { workspaceId, services, number, actor } = await desk([RESEND_DOMAINS, { match: "POST https://api.resend.com/emails", status: 500, json: { message: "Down" } }]);
    await replyNow(services, workspaceId, number, "Hello", actor);
    const failed = await lastMessage(workspaceId, number);
    const { services: healthy, calls } = testServices(db);
    expect((await sendReply(healthy, workspaceId, failed?.id as string, actor, { body: "Hello again" })).ok).toBe(true);
    expect(JSON.parse(sends(calls)[0].body).text).toContain("Hello again");
    expect(await lastMessage(workspaceId, number)).toMatchObject({ deliveryState: "sent", deliveryError: null, body: "Hello again" });
  });

  it("uses a new idempotency key once the service reported the last try failed, and the same one after dying halfway", async () => {
    const { workspaceId, services, calls, number, actor } = await desk();
    await replyNow(services, workspaceId, number, "Hello", actor);
    const firstKey = sends(calls)[0].headers.get("idempotency-key");
    await recordDeliveryReport(services, workspaceId, { providerId: "resend-sent-1", outcome: "failed", messageId: null, detail: "Rejected" });
    const reply = await lastMessage(workspaceId, number).then(async () => (await ticketForTeam(db, workspaceId, number))?.messages.find(({ kind }) => kind === "agent"));
    const { services: again, calls: againCalls } = testServices(db, [{ match: "POST https://api.resend.com/emails", json: { id: "resend-sent-2" } }]);
    await sendReply(again, workspaceId, reply?.id as string, actor);
    expect(sends(againCalls)[0].headers.get("idempotency-key")).not.toBe(firstKey);
  });

  it("can't leave twice: a second press finds nothing waiting", async () => {
    const { workspaceId, services, calls, number, actor } = await desk();
    const drafted = await saveDraft(db, workspaceId, number, "Hello", actor);
    if (!drafted.ok) throw new Error(drafted.error);
    await sendReply(services, workspaceId, drafted.draftId, actor);
    expect(await sendReply(services, workspaceId, drafted.draftId, actor)).toMatchObject({ ok: false, error: expect.stringContaining("isn’t waiting to be sent") });
    expect(sends(calls)).toHaveLength(1);
  });
});

describe("a draft", () => {
  it("sends nothing, and changes nothing on the ticket", async () => {
    const { workspaceId, calls, number, actor } = await desk();
    const before = await ticketRow(workspaceId, number);
    expect((await saveDraft(db, workspaceId, number, "Maybe this", { ...actor, writtenBy: "assistant" })).ok).toBe(true);
    expect(sends(calls)).toEqual([]);
    expect(await lastMessage(workspaceId, number)).toMatchObject({ kind: "agent", deliveryState: "draft", writtenBy: "assistant" });
    expect(await ticketRow(workspaceId, number)).toMatchObject({ status: before.status, firstResponseAt: null, lastMessageAt: before.lastMessageAt });
  });

  it("is sent by a member, and still says an assistant wrote it unless they changed the words", async () => {
    const { workspaceId, services, number, actor } = await desk();
    const drafted = await saveDraft(db, workspaceId, number, "From the assistant", { ...actor, writtenBy: "assistant" });
    if (!drafted.ok) throw new Error(drafted.error);
    await sendReply(services, workspaceId, drafted.draftId, actor, { body: "From the assistant" });
    expect(await lastMessage(workspaceId, number)).toMatchObject({ writtenBy: "assistant", authorUserId: actor.userId, deliveryState: "sent" });
  });

  it("becomes the member's once they rewrite it", async () => {
    const { workspaceId, services, number, actor } = await desk();
    const drafted = await saveDraft(db, workspaceId, number, "From the assistant", { ...actor, writtenBy: "assistant" });
    if (!drafted.ok) throw new Error(drafted.error);
    await sendReply(services, workspaceId, drafted.draftId, actor, { body: "Rewritten" });
    expect(await lastMessage(workspaceId, number)).toMatchObject({ writtenBy: "member", body: "Rewritten" });
  });

  it("can be thrown away, while one already sent can't", async () => {
    const { workspaceId, services, number, actor } = await desk();
    const drafted = await saveDraft(db, workspaceId, number, "Maybe", actor);
    if (!drafted.ok) throw new Error(drafted.error);
    expect(await discardDraft(db, workspaceId, drafted.draftId)).toBe(true);
    await replyNow(services, workspaceId, number, "Sent", actor);
    const sent = await lastMessage(workspaceId, number);
    expect(await discardDraft(db, workspaceId, sent?.id as string)).toBe(false);
  });

  it("isn't reached from another workspace", async () => {
    const mine = await desk();
    const theirs = await desk();
    const drafted = await saveDraft(db, theirs.workspaceId, theirs.number, "Theirs", theirs.actor);
    if (!drafted.ok) throw new Error(drafted.error);
    expect((await sendReply(mine.services, mine.workspaceId, drafted.draftId, mine.actor)).ok).toBe(false);
    expect(await discardDraft(db, mine.workspaceId, drafted.draftId)).toBe(false);
  });
});

describe("approve-first", () => {
  async function drafted() {
    const seat = await desk();
    const draft = await saveDraft(db, seat.workspaceId, seat.number, "From the assistant", { ...seat.actor, writtenBy: "assistant" });
    if (!draft.ok) throw new Error(draft.error);
    return { ...seat, draftId: draft.draftId };
  }

  it("is how a workspace starts: an assistant's send is refused and nothing leaves", async () => {
    const { workspaceId, userId, services, calls, number, draftId } = await drafted();
    expect((await settingsOf(db, workspaceId)).assistantMaySend).toBe(false);
    expect(await sendReplyAsAssistant(services, workspaceId, userId, draftId)).toEqual({ ok: false, error: APPROVE_FIRST });
    expect(sends(calls)).toEqual([]);
    expect(await lastMessage(workspaceId, number)).toMatchObject({ deliveryState: "draft" });
  });

  it("lets it send once an owner allowed it on the screen", async () => {
    const { workspaceId, userId, services, calls, number, draftId } = await drafted();
    expect((await setAssistantMaySend(db, workspaceId, userId, true)).ok).toBe(true);
    expect((await sendReplyAsAssistant(services, workspaceId, userId, draftId)).ok).toBe(true);
    expect(sends(calls)).toHaveLength(1);
    expect(await lastMessage(workspaceId, number)).toMatchObject({ deliveryState: "sent", writtenBy: "assistant" });
  });

  it("goes back at once when it's taken away", async () => {
    const { workspaceId, userId, services, draftId } = await drafted();
    await setAssistantMaySend(db, workspaceId, userId, true);
    await setAssistantMaySend(db, workspaceId, userId, false);
    expect((await sendReplyAsAssistant(services, workspaceId, userId, draftId)).ok).toBe(false);
  });

  it("can't be changed by a plain member, or by someone from elsewhere", async () => {
    const { workspaceId } = await drafted();
    const plain = crypto.randomUUID();
    await db.insert(user).values({ id: plain, name: "Bea", email: `${plain}@example.test` });
    await db.insert(member).values({ workspaceId, userId: plain, role: "member" });
    expect((await setAssistantMaySend(db, workspaceId, plain, true)).ok).toBe(false);
    const elsewhere = await createTestWorkspace(db, "Elsewhere");
    expect((await setAssistantMaySend(db, workspaceId, elsewhere.userId, true)).ok).toBe(false);
    expect((await settingsOf(db, workspaceId)).assistantMaySend).toBe(false);
  });

  it("lets an admin change it", async () => {
    const { workspaceId } = await drafted();
    const admin = crypto.randomUUID();
    await db.insert(user).values({ id: admin, name: "Bea", email: `${admin}@example.test` });
    await db.insert(member).values({ workspaceId, userId: admin, role: "admin" });
    expect((await setAssistantMaySend(db, workspaceId, admin, true)).ok).toBe(true);
  });

  it("is each workspace's own", async () => {
    const mine = await drafted();
    const theirs = await drafted();
    await setAssistantMaySend(db, mine.workspaceId, mine.userId, true);
    expect((await settingsOf(db, theirs.workspaceId)).assistantMaySend).toBe(false);
    expect((await sendReplyAsAssistant(theirs.services, theirs.workspaceId, theirs.userId, theirs.draftId)).ok).toBe(false);
  });
});
