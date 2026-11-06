import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { recordInboundMail } from "@/application/inbound-mail";
import { addProductAddress, productAddressesOf, removeProductAddress, setAddressScreening } from "@/application/product-addresses";
import { deleteProduct, updateProduct } from "@/application/products";
import { dismissScreenedMails, promoteScreenedMail, screenedMailOf, screenedWaitingCount } from "@/application/screened-mail";
import { ticketForTeam } from "@/application/ticket-queries";
import type { Database } from "@/infrastructure/db/client";
import { contact, screenedMail, ticket } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { addProduct, inboundEmail, NOW, openTicket } from "./support/desk";
import { addTeammate, mailingServices, noticesIn, recipientsIn } from "./support/notices";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

/** A workspace with a product and a teammate who'd hear of any ticket, on an instance that can mail them. */
async function desk() {
  const { workspaceId, userId } = await createTestWorkspace(db);
  const { services, calls } = mailingServices(db);
  const product = await addProduct(db, workspaceId, userId);
  const teammate = await addTeammate(db, workspaceId);
  return { workspaceId, userId, services, calls, product, teammate };
}

const ELSEWHERE = ["sales@another-domain.example"];
const waiting = async (workspaceId: string) => (await screenedMailOf(db, workspaceId, "waiting")).mails;
const dismissed = async (workspaceId: string) => (await screenedMailOf(db, workspaceId, "dismissed")).mails;
const tickets = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(ticket));
const contacts = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(contact));

describe("a new mail sent to no product's address", () => {
  it("is kept whole, with no ticket, no contact and nobody told", async () => {
    const { workspaceId, services, calls } = await desk();
    const email = inboundEmail({ addressedTo: ELSEWHERE, subject: " Cheap watches ", text: "Buy now.", attachments: [{ filename: "a.pdf", contentType: "application/pdf", size: 3 }], receivedAt: new Date("2026-10-15T18:41:46Z") });
    expect(await recordInboundMail(services, workspaceId, email)).toBe("screened");
    expect(await waiting(workspaceId)).toMatchObject([{ fromAddress: "ada@customer.example", fromName: "Ada Martin", addressedTo: ELSEWHERE, subject: "Cheap watches", body: "Buy now.", providerId: email.providerId, emailMessageId: email.messageId, receivedAt: new Date("2026-10-15T18:41:46Z"), attachments: email.attachments, reason: "no_product", productId: null, state: "waiting" }]);
    expect(await tickets(workspaceId)).toEqual([]);
    expect(await contacts(workspaceId)).toEqual([]);
    expect(noticesIn(calls)).toEqual([]);
    expect(calls.filter(({ method }) => method === "POST")).toEqual([]);
  });

  it("is dated when it reached the app if the service doesn't say", async () => {
    const { workspaceId, services } = await desk();
    await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ELSEWHERE }));
    expect((await waiting(workspaceId))[0].receivedAt).toEqual(NOW);
  });

  it("is kept once when it's posted twice, by the service's id or its Message-ID, even once dismissed", async () => {
    const { workspaceId, userId, services } = await desk();
    const email = inboundEmail({ addressedTo: ELSEWHERE });
    expect(await recordInboundMail(services, workspaceId, email)).toBe("screened");
    expect(await recordInboundMail(services, workspaceId, email)).toBe("duplicate");
    expect(await recordInboundMail(services, workspaceId, { ...email, providerId: "another-id" })).toBe("duplicate");
    const [mail] = await waiting(workspaceId);
    await dismissScreenedMails(services, workspaceId, userId, [mail.id]);
    expect(await recordInboundMail(services, workspaceId, email)).toBe("duplicate");
    expect(await dismissed(workspaceId)).toHaveLength(1);
  });

  it("is screened by a workspace with one product, one with no address, or none at all", async () => {
    const one = await desk();
    expect(await recordInboundMail(one.services, one.workspaceId, inboundEmail({ addressedTo: ELSEWHERE }))).toBe("screened");
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = mailingServices(db);
    expect(await recordInboundMail(services, workspaceId, inboundEmail())).toBe("screened");
    await addProduct(db, workspaceId, userId, "No address yet", "");
    expect(await recordInboundMail(services, workspaceId, inboundEmail())).toBe("screened");
    expect(await tickets(workspaceId)).toEqual([]);
  });

  it("survives a NUL in its text and a mail with no sender address", async () => {
    const { workspaceId, services } = await desk();
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ELSEWHERE, text: "Bad\u0000 byte" }))).toBe("screened");
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ from: "no address here", fromName: null }))).toBe("screened");
    const reasons = (await waiting(workspaceId)).map(({ reason, body }) => [reason, body]);
    expect(reasons).toEqual(expect.arrayContaining([["no_product", "Bad byte"], ["no_sender", "I can’t sign in."]]));
  });
});

describe("a new mail flagged by what it carries", () => {
  it.each([
    ["the service's spam verdict", { headers: { "x-ses-spam-verdict": "FAIL" } }, "service_flag"],
    ["the service's virus verdict", { headers: { "x-ses-virus-verdict": "FAIL" } }, "service_flag"],
    ["a failed DMARC check", { authentication: { dmarc: "fail" } }, "forged"],
    ["failed SPF and DKIM checks", { authentication: { spf: "fail", dkim: "fail" } }, "forged"],
    ["a machine's headers", { headers: { precedence: "bulk" } }, "machine"],
  ])("waits, with its product already chosen, for %s, even on a product's address", async (_, overrides, reason) => {
    const { workspaceId, services, calls, product } = await desk();
    expect(await recordInboundMail(services, workspaceId, inboundEmail(overrides))).toBe("screened");
    expect(await waiting(workspaceId)).toMatchObject([{ reason, productId: product.id }]);
    expect(await tickets(workspaceId)).toEqual([]);
    expect(noticesIn(calls)).toEqual([]);
  });

  it("opens a ticket when the verdict passes", async () => {
    const { workspaceId, services } = await desk();
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ headers: { "x-ses-spam-verdict": "PASS", "x-ses-virus-verdict": "PASS" } }))).toBe("opened");
  });
});

describe("an answer to a ticket", () => {
  it("gets through from any address, by its token or its headers, even with everything against it", async () => {
    const { workspaceId, services } = await desk();
    const first = inboundEmail();
    expect(await recordInboundMail(services, workspaceId, first)).toBe("opened");
    const [{ replyToken, number }] = await tickets(workspaceId);
    const against = { headers: { "x-ses-spam-verdict": "FAIL" }, authentication: { dmarc: "fail" } };
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ ...against, addressedTo: [`old+${replyToken}@another-domain.example`], from: "someone@elsewhere.example" }))).toBe("continued");
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ ...against, addressedTo: ELSEWHERE, inReplyTo: first.messageId }))).toBe("continued");
    expect((await ticketForTeam(db, workspaceId, number))?.messages).toHaveLength(3);
    expect(await waiting(workspaceId)).toEqual([]);
  });

  it("from a machine is still noted on the ticket, not screened", async () => {
    const { workspaceId, services } = await desk();
    const first = inboundEmail();
    await recordInboundMail(services, workspaceId, first);
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ELSEWHERE, inReplyTo: first.messageId, headers: { "auto-submitted": "auto-replied" } }))).toBe("noted");
    expect(await waiting(workspaceId)).toEqual([]);
  });
});

describe("a product's other addresses", () => {
  it("open a ticket for it: an address, or any address on a domain", async () => {
    const { workspaceId, userId, services, product, calls, teammate } = await desk();
    expect(await addProductAddress(db, workspaceId, userId, product.id, "Contact@Site.example", false)).toMatchObject({ ok: true });
    expect(await addProductAddress(db, workspaceId, userId, product.id, "@other-site.example", false)).toMatchObject({ ok: true });
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ["contact@site.example"] }))).toBe("opened");
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ["anyone@other-site.example"] }))).toBe("opened");
    expect((await tickets(workspaceId)).map(({ productId }) => productId)).toEqual([product.id, product.id]);
    expect(recipientsIn(calls)).toContain(teammate.email);
  });

  it("screen first when asked, keeping the product chosen, and a change of mind applies to what comes next", async () => {
    const { workspaceId, userId, services, product } = await desk();
    await addProductAddress(db, workspaceId, userId, product.id, "site.example", true);
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ["contact@site.example"] }))).toBe("screened");
    expect(await waiting(workspaceId)).toMatchObject([{ reason: "address_rule", productId: product.id }]);
    const [rule] = await productAddressesOf(db, workspaceId);
    expect(await setAddressScreening(db, workspaceId, userId, rule.id, false)).toMatchObject({ ok: true });
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ["contact@site.example"] }))).toBe("opened");
  });

  it("include the support address itself when it's set to screen first, and an answer to a ticket still gets through", async () => {
    const { workspaceId, userId, services, product } = await desk();
    const first = inboundEmail();
    await recordInboundMail(services, workspaceId, first);
    const updated = await updateProduct(db, workspaceId, userId, product.id, { name: product.name, screensSupportAddress: true });
    expect(updated.ok).toBe(true);
    expect(await recordInboundMail(services, workspaceId, inboundEmail())).toBe("screened");
    expect(await waiting(workspaceId)).toMatchObject([{ reason: "address_rule", productId: product.id }]);
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ inReplyTo: first.messageId }))).toBe("continued");
    expect(await tickets(workspaceId)).toHaveLength(1);
  });

  it("put an address before a domain across products, and leave the support address with its own", async () => {
    const { workspaceId, userId, services, product } = await desk();
    const other = await addProduct(db, workspaceId, userId, "Other", "help@other.example");
    await addProductAddress(db, workspaceId, userId, other.id, "acme.example", true);
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ["support@acme.example"] }))).toBe("opened");
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ["sales@acme.example"] }))).toBe("screened");
    expect((await tickets(workspaceId))[0].productId).toBe(product.id);
    expect((await waiting(workspaceId))[0].productId).toBe(other.id);
  });

  it("are refused when they aren't one, or another product already holds them", async () => {
    const { workspaceId, userId, product } = await desk();
    const other = await addProduct(db, workspaceId, userId, "Other", "help@other.example");
    expect(await addProductAddress(db, workspaceId, userId, product.id, "not an address", false)).toMatchObject({ ok: false, error: expect.stringContaining("Type an address") });
    expect(await addProductAddress(db, workspaceId, userId, product.id, "help@other.example", false)).toMatchObject({ ok: false, error: expect.stringContaining("Other") });
    await addProductAddress(db, workspaceId, userId, other.id, "site.example", false);
    expect(await addProductAddress(db, workspaceId, userId, product.id, "site.example", true)).toMatchObject({ ok: false, error: expect.stringContaining("Other") });
    expect(await productAddressesOf(db, workspaceId)).toHaveLength(1);
  });

  it("stay with owners and admins", async () => {
    const { workspaceId, userId, product, teammate } = await desk();
    await addProductAddress(db, workspaceId, userId, product.id, "site.example", false);
    const [rule] = await productAddressesOf(db, workspaceId);
    expect((await addProductAddress(db, workspaceId, teammate.userId, product.id, "another.example", false)).ok).toBe(false);
    expect((await setAddressScreening(db, workspaceId, teammate.userId, rule.id, true)).ok).toBe(false);
    expect(await removeProductAddress(db, workspaceId, teammate.userId, rule.id)).toBe(false);
    expect(await productAddressesOf(db, workspaceId)).toMatchObject([{ value: "site.example", screens: false }]);
  });

  it("lose nothing when taken off, or when their product goes: mail waits in Screened", async () => {
    const { workspaceId, userId, services, product } = await desk();
    await addProductAddress(db, workspaceId, userId, product.id, "site.example", false);
    const [rule] = await productAddressesOf(db, workspaceId);
    expect(await removeProductAddress(db, workspaceId, userId, rule.id)).toBe(true);
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ["contact@site.example"] }))).toBe("screened");
    await addProductAddress(db, workspaceId, userId, product.id, "site.example", true);
    await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ["again@site.example"] }));
    await deleteProduct(db, workspaceId, userId, product.id);
    expect(await productAddressesOf(db, workspaceId)).toEqual([]);
    expect(await waiting(workspaceId)).toHaveLength(2);
    expect((await waiting(workspaceId)).every(({ productId }) => productId === null)).toBe(true);
  });

  it("count as our own address when they write in: nothing opens", async () => {
    const { workspaceId, userId, services, product } = await desk();
    await addProductAddress(db, workspaceId, userId, product.id, "contact@site.example", false);
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ from: "contact@site.example", addressedTo: ["contact@site.example"] }))).toBe("screened");
    expect(await waiting(workspaceId)).toMatchObject([{ reason: "own_address" }]);
  });
});

describe("opening a ticket from a screened mail", () => {
  async function screened() {
    const seat = await desk();
    const email = inboundEmail({ addressedTo: ELSEWHERE, subject: "A real question", text: "How does it work?", receivedAt: new Date("2026-10-15T18:41:46Z"), attachments: [{ filename: "a.pdf", contentType: "application/pdf", size: 3 }] });
    await recordInboundMail(seat.services, seat.workspaceId, email);
    const [mail] = await waiting(seat.workspaceId);
    return { ...seat, email, mail };
  }

  it("makes a ticket for the product chosen, dated when the mail came, with its contact and its mail ids", async () => {
    const { workspaceId, userId, services, product, mail, email } = await screened();
    const promoted = await promoteScreenedMail(services, workspaceId, userId, mail.id, product.id);
    expect(promoted).toEqual({ ok: true, number: 1 });
    expect(await tickets(workspaceId)).toMatchObject([{ number: 1, subject: "A real question", productId: product.id, channel: "email", status: "open", createdAt: mail.receivedAt, lastMessageAt: mail.receivedAt }]);
    expect(await contacts(workspaceId)).toMatchObject([{ email: "ada@customer.example", name: "Ada Martin" }]);
    const messages = (await ticketForTeam(db, workspaceId, 1))?.messages ?? [];
    expect(messages[0]).toMatchObject({ kind: "customer", body: "How does it work?", providerId: email.providerId, emailMessageId: email.messageId, createdAt: mail.receivedAt, attachments: email.attachments });
    expect(messages.at(-1)).toMatchObject({ kind: "system", body: expect.stringContaining("opened this from Screened") });
    expect(await waiting(workspaceId)).toEqual([]);
    const [kept] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(screenedMail).where(eq(screenedMail.id, mail.id)));
    expect(kept).toMatchObject({ state: "promoted", decidedBy: userId, decidedAt: NOW });
    expect(kept.ticketId).toBeTruthy();
  });

  it("tells the team and not whoever opened it, and never mails the sender", async () => {
    const { workspaceId, userId, services, calls, mail, teammate } = await screened();
    await promoteScreenedMail(services, workspaceId, userId, mail.id, null);
    expect(recipientsIn(calls)).toEqual([teammate.email]);
    expect(calls.filter(({ url }) => url === "https://api.resend.com/emails")).toEqual([]);
  });

  it("finds the ticket when the sender answers the mail it came from, and doesn't screen it again", async () => {
    const { workspaceId, userId, services, product, mail, email } = await screened();
    await promoteScreenedMail(services, workspaceId, userId, mail.id, product.id);
    expect(await recordInboundMail(services, workspaceId, email)).toBe("duplicate");
    expect(await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ELSEWHERE, inReplyTo: email.messageId }))).toBe("continued");
    expect(await tickets(workspaceId)).toHaveLength(1);
  });

  it("keeps the warning on a mail whose sender checks failed", async () => {
    const { workspaceId, userId, services } = await desk();
    await recordInboundMail(services, workspaceId, inboundEmail({ authentication: { dmarc: "fail" } }));
    const [mail] = await waiting(workspaceId);
    expect(mail.senderSuspect).toBe(true);
    await promoteScreenedMail(services, workspaceId, userId, mail.id, null);
    expect((await ticketForTeam(db, workspaceId, 1))?.messages[0].senderSuspect).toBe(true);
  });

  it("happens once", async () => {
    const { workspaceId, userId, services, mail } = await screened();
    expect((await promoteScreenedMail(services, workspaceId, userId, mail.id, null)).ok).toBe(true);
    expect(await promoteScreenedMail(services, workspaceId, userId, mail.id, null)).toMatchObject({ ok: false, error: expect.stringContaining("already") });
    expect(await tickets(workspaceId)).toHaveLength(1);
  });

  it("is refused for a mail with no sender address: there's nobody to answer", async () => {
    const { workspaceId, userId, services } = await desk();
    await recordInboundMail(services, workspaceId, inboundEmail({ from: "no address here" }));
    const [mail] = await waiting(workspaceId);
    expect(await promoteScreenedMail(services, workspaceId, userId, mail.id, null)).toMatchObject({ ok: false, error: expect.stringContaining("no sender address") });
    expect(await tickets(workspaceId)).toEqual([]);
  });

  it("still works once dismissed: a wrong dismissal isn't final", async () => {
    const { workspaceId, userId, services, mail } = await screened();
    await dismissScreenedMails(services, workspaceId, userId, [mail.id]);
    expect((await promoteScreenedMail(services, workspaceId, userId, mail.id, null)).ok).toBe(true);
    expect(await dismissed(workspaceId)).toEqual([]);
  });
});

describe("dismissing and listing", () => {
  it("sets mail aside, alone or in bulk, and counts each tab", async () => {
    const { workspaceId, userId, services } = await desk();
    for (const subject of ["One", "Two", "Three"]) await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ELSEWHERE, subject }));
    const [first, second] = await waiting(workspaceId);
    expect(await screenedWaitingCount(db, workspaceId)).toBe(3);
    expect(await dismissScreenedMails(services, workspaceId, userId, [first.id])).toEqual({ ok: true, said: "1 mail dismissed." });
    expect(await dismissScreenedMails(services, workspaceId, userId, [first.id, second.id])).toEqual({ ok: true, said: "1 mail dismissed." });
    const { counts, mails } = await screenedMailOf(db, workspaceId, "dismissed");
    expect(counts).toEqual({ waiting: 1, dismissed: 2 });
    expect(mails[0]).toMatchObject({ decidedBy: userId, decidedAt: NOW });
    expect(await screenedWaitingCount(db, workspaceId)).toBe(1);
  });

  it("asks for a selection, and takes no notice of what isn't an id", async () => {
    const { workspaceId, userId, services } = await desk();
    expect(await dismissScreenedMails(services, workspaceId, userId, [])).toEqual({ ok: false, error: "Select some mail first." });
    expect(await dismissScreenedMails(services, workspaceId, userId, ["not an id"])).toEqual({ ok: false, error: "Select some mail first." });
    expect(await promoteScreenedMail(services, workspaceId, userId, "not an id", null)).toMatchObject({ ok: false });
  });

  it("pages through a long list, latest first", async () => {
    const { workspaceId, services } = await desk();
    for (let day = 1; day <= 51; day++) await recordInboundMail(services, workspaceId, inboundEmail({ addressedTo: ELSEWHERE, subject: `Day ${day}`, receivedAt: new Date(Date.UTC(2026, 6, day)) }));
    const first = await screenedMailOf(db, workspaceId, "waiting");
    expect(first.mails).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(first.mails[0].subject).toBe("Day 51");
    const second = await screenedMailOf(db, workspaceId, "waiting", 2);
    expect(second.mails.map(({ subject }) => subject)).toEqual(["Day 1"]);
    expect(second.hasMore).toBe(false);
  });
});

describe("between workspaces", () => {
  async function two() {
    const mine = await desk();
    const theirs = await desk();
    await recordInboundMail(theirs.services, theirs.workspaceId, inboundEmail({ addressedTo: ELSEWHERE, subject: "Theirs" }));
    const [mail] = await waiting(theirs.workspaceId);
    return { mine, theirs, mail };
  }

  it("shows nothing of another's list, and counts none of it", async () => {
    const { mine, mail } = await two();
    expect(await waiting(mine.workspaceId)).toEqual([]);
    expect(await screenedWaitingCount(db, mine.workspaceId)).toBe(0);
    expect(await withWorkspace(db, mine.workspaceId, (tx) => tx.select().from(screenedMail).where(eq(screenedMail.id, mail.id)))).toEqual([]);
  });

  it("can't promote or dismiss another's mail, by its id", async () => {
    const { mine, theirs, mail } = await two();
    expect(await promoteScreenedMail(mine.services, mine.workspaceId, mine.userId, mail.id, mine.product.id)).toMatchObject({ ok: false, error: "This mail is no longer here." });
    expect(await dismissScreenedMails(mine.services, mine.workspaceId, mine.userId, [mail.id])).toEqual({ ok: true, said: "0 mails dismissed." });
    expect(await waiting(theirs.workspaceId)).toMatchObject([{ id: mail.id, state: "waiting" }]);
    expect(await tickets(mine.workspaceId)).toEqual([]);
  });

  it("can't put a mail on another's product", async () => {
    const { mine, theirs, mail } = await two();
    expect(await promoteScreenedMail(theirs.services, theirs.workspaceId, theirs.userId, mail.id, mine.product.id)).toMatchObject({ ok: false, error: expect.stringContaining("no such product") });
    expect(await tickets(theirs.workspaceId)).toEqual([]);
    expect(await waiting(theirs.workspaceId)).toHaveLength(1);
  });

  it("can't take a row written into another's workspace, or see an address it holds", async () => {
    const { mine, theirs } = await two();
    const row = { workspaceId: theirs.workspaceId, providerId: "planted", fromAddress: "a@b.example", subject: "s", body: "b", reason: "no_product" as const, receivedAt: NOW };
    await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.insert(screenedMail).values(row))).rejects.toThrow();
    await addProductAddress(db, theirs.workspaceId, theirs.userId, theirs.product.id, "site.example", false);
    expect(await productAddressesOf(db, mine.workspaceId)).toEqual([]);
  });

  it("doesn't route by another's addresses, or let one be set on another's product or by its id", async () => {
    const { mine, theirs } = await two();
    await addProductAddress(db, theirs.workspaceId, theirs.userId, theirs.product.id, "site.example", false);
    const [rule] = await productAddressesOf(db, theirs.workspaceId);
    expect(await recordInboundMail(mine.services, mine.workspaceId, inboundEmail({ addressedTo: ["contact@site.example"] }))).toBe("screened");
    expect(await addProductAddress(db, mine.workspaceId, mine.userId, theirs.product.id, "taken.example", false)).toMatchObject({ ok: false, error: "This product no longer exists." });
    expect((await setAddressScreening(db, mine.workspaceId, mine.userId, rule.id, true)).ok).toBe(false);
    expect(await removeProductAddress(db, mine.workspaceId, mine.userId, rule.id)).toBe(false);
    expect(await productAddressesOf(db, theirs.workspaceId)).toMatchObject([{ value: "site.example", screens: false }]);
  });

  it("keeps the same mail apart, and the same value free for each", async () => {
    const { mine, theirs } = await two();
    const email = inboundEmail({ addressedTo: ELSEWHERE });
    expect(await recordInboundMail(mine.services, mine.workspaceId, email)).toBe("screened");
    expect(await recordInboundMail(theirs.services, theirs.workspaceId, email)).toBe("screened");
    expect((await addProductAddress(db, mine.workspaceId, mine.userId, mine.product.id, "shared.example", false)).ok).toBe(true);
    expect((await addProductAddress(db, theirs.workspaceId, theirs.userId, theirs.product.id, "shared.example", false)).ok).toBe(true);
  });

  it("shows nothing with no workspace set, even as the app role", async () => {
    const { mail } = await two();
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('role', 'tenant_app', true)`);
      return tx.select().from(screenedMail).where(eq(screenedMail.id, mail.id));
    });
    expect(rows).toEqual([]);
  });
});

describe("a ticket opened any other way", () => {
  it("is unchanged: it's dated now", async () => {
    const { workspaceId, services } = await desk();
    await openTicket(services, workspaceId);
    expect((await tickets(workspaceId))[0].lastMessageAt).toEqual(NOW);
  });
});
