import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { addCategory, categoriesOf, removeCategory } from "@/application/categories";
import { findContacts } from "@/application/contacts";
import { addNote } from "@/application/conversation";
import { createProduct, deleteProduct, productsOf, renewPublicKey, updateProduct } from "@/application/products";
import { addSavedReply, removeSavedReply, savedRepliesOf } from "@/application/saved-replies";
import { removeMember } from "@/application/team";
import { listTickets, tagsInUse, ticketForTeam } from "@/application/ticket-queries";
import { createTicket, updateTicket, updateTickets } from "@/application/tickets";
import { filtersOf, inboxHref, pageOf, statusTab } from "@/app/tickets/query";
import { cleanTags, newTicketInput, oneLine } from "@/domain/ticket-input";
import { DEFAULT_CATEGORIES, isSettled, resolvedAtAfter, statusAfterReply } from "@/domain/tickets";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { ticket } from "@/infrastructure/db/schema/support";
import { member } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { addProduct, NOW, openTicket, testServices } from "./support/desk";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

async function desk() {
  const seat = await createTestWorkspace(db);
  const { services } = testServices(db);
  return { ...seat, services, actor: { userId: seat.userId, writtenBy: "member" as const } };
}

async function teammate(workspaceId: string, role: "admin" | "member" = "member", name = "Bea") {
  const id = crypto.randomUUID();
  await db.insert(user).values({ id, name, email: `${id}@example.test` });
  await db.insert(member).values({ workspaceId, userId: id, role });
  return id;
}

const row = async (workspaceId: string, number: number) => (await withWorkspace(db, workspaceId, (tx) => tx.select().from(ticket).where(eq(ticket.number, number))))[0];
const numbers = (listed: { tickets: { number: number }[] }) => listed.tickets.map(({ number }) => number).sort((a, b) => a - b);

describe("how a ticket moves", () => {
  it("counts as resolved from the first time it settled, until it opens again", () => {
    const earlier = new Date("2026-01-01T00:00:00Z");
    expect(resolvedAtAfter("resolved", null, NOW)).toBe(NOW);
    expect(resolvedAtAfter("closed", earlier, NOW)).toBe(earlier);
    expect(resolvedAtAfter("open", earlier, NOW)).toBeNull();
    expect(resolvedAtAfter("pending", earlier, NOW)).toBeNull();
    expect(["open", "pending", "resolved", "closed"].map((status) => isSettled(status as never))).toEqual([false, false, true, true]);
  });

  it("waits on the requester after a reply, unless the member settled it", () => {
    expect(statusAfterReply(undefined)).toBe("pending");
    expect(statusAfterReply("resolved")).toBe("resolved");
  });
});

describe("what comes in", () => {
  it("is one line where it must be, so nothing can forge a header", () => {
    expect(oneLine(" Hello\r\nBcc: x@y.example\t ")).toBe("Hello Bcc: x@y.example");
    expect(oneLine(undefined)).toBe("");
  });

  it("keeps tags lowercase, once each, and within limits", () => {
    expect(cleanTags([" VIP ", "vip", "", "Billing"])).toEqual(["vip", "billing"]);
    expect(cleanTags(Array.from({ length: 30 }, (_, index) => `t${index}`))).toHaveLength(20);
    expect(cleanTags(["x".repeat(60)])[0]).toHaveLength(40);
  });

  it("normalises the requester's address", () => {
    expect(newTicketInput.parse({ subject: "A", message: "B", requester: { email: " ADA@Acme.Example " } }).requester.email).toBe("ada@acme.example");
  });

  it("takes only a web address for a link", () => {
    const about = (url: string) => newTicketInput.safeParse({ subject: "A", message: "B", requester: { email: "a@b.example" }, about: { url } }).success;
    expect(about("https://acme.example/x")).toBe(true);
    expect(about("http://acme.example/x")).toBe(true);
    for (const url of ["javascript:alert(1)", "data:text/html,x", "ftp://acme.example", "not a url"]) expect(about(url)).toBe(false);
  });
});

describe("a new workspace", () => {
  it("starts with the default categories, its own", async () => {
    const { workspaceId } = await desk();
    const other = await desk();
    expect((await categoriesOf(db, workspaceId)).map(({ name }) => name)).toEqual([...DEFAULT_CATEGORIES]);
    await addCategory(db, workspaceId, "Refunds");
    expect((await categoriesOf(db, other.workspaceId)).map(({ name }) => name)).not.toContain("Refunds");
  });
});

describe("changing a ticket", () => {
  it("saves what changed and notes it for the team", async () => {
    const { workspaceId, services, userId, actor } = await desk();
    const { number } = await openTicket(services, workspaceId);
    const updated = await updateTicket(services, workspaceId, number, { status: "resolved", priority: "urgent", assigneeId: userId }, actor);
    expect(updated).toMatchObject({ ok: true, ticket: { status: "resolved", priority: "urgent", assigneeId: userId, resolvedAt: NOW } });
    const lines = (await ticketForTeam(db, workspaceId, number))?.messages.filter(({ kind }) => kind === "system").map(({ body }) => body);
    expect(lines).toEqual(["Ada set the status to Resolved.", "Ada set the priority to Urgent.", "Ada assigned this to Ada."]);
  });

  it("says when an assistant did it", async () => {
    const { workspaceId, services, userId } = await desk();
    const { number } = await openTicket(services, workspaceId);
    await updateTicket(services, workspaceId, number, { status: "pending" }, { userId, writtenBy: "assistant" });
    expect((await ticketForTeam(db, workspaceId, number))?.messages.at(-1)).toMatchObject({ kind: "system", body: "Ada’s assistant set the status to Pending.", writtenBy: "assistant" });
  });

  it("clears when it was resolved if it opens again", async () => {
    const { workspaceId, services, actor } = await desk();
    const { number } = await openTicket(services, workspaceId);
    await updateTicket(services, workspaceId, number, { status: "closed" }, actor);
    await updateTicket(services, workspaceId, number, { status: "open" }, actor);
    expect((await row(workspaceId, number)).resolvedAt).toBeNull();
  });

  it("adds, removes and replaces tags", async () => {
    const { workspaceId, services, actor } = await desk();
    const { number } = await openTicket(services, workspaceId, { tags: ["one"] });
    await updateTicket(services, workspaceId, number, { addTags: ["Two", "one"] }, actor);
    expect((await row(workspaceId, number)).tags).toEqual(["one", "two"]);
    await updateTicket(services, workspaceId, number, { removeTags: ["ONE"] }, actor);
    expect((await row(workspaceId, number)).tags).toEqual(["two"]);
    await updateTicket(services, workspaceId, number, { tags: ["three", " "] }, actor);
    expect((await row(workspaceId, number)).tags).toEqual(["three"]);
    expect(await tagsInUse(db, workspaceId)).toEqual(["three"]);
  });

  it("assigns only to someone in this workspace, and can take it off them", async () => {
    const { workspaceId, services, actor } = await desk();
    const elsewhere = await desk();
    const { number } = await openTicket(services, workspaceId);
    expect(await updateTicket(services, workspaceId, number, { assigneeId: elsewhere.userId }, actor)).toMatchObject({ ok: false, error: expect.stringContaining("isn’t in this workspace") });
    const bea = await teammate(workspaceId);
    await updateTicket(services, workspaceId, number, { assigneeId: bea }, actor);
    await updateTicket(services, workspaceId, number, { assigneeId: null }, actor);
    expect((await ticketForTeam(db, workspaceId, number))?.messages.at(-1)?.body).toBe("Ada took this off Bea.");
  });

  it("refuses another workspace's product or category, which a foreign key alone would let through", async () => {
    const { workspaceId, services, actor } = await desk();
    const theirs = await desk();
    const product = await addProduct(db, theirs.workspaceId, theirs.userId);
    const [category] = await categoriesOf(db, theirs.workspaceId);
    const { number } = await openTicket(services, workspaceId);
    expect((await updateTicket(services, workspaceId, number, { productId: product.id }, actor)).ok).toBe(false);
    expect((await updateTicket(services, workspaceId, number, { categoryId: category.id }, actor)).ok).toBe(false);
    expect(await row(workspaceId, number)).toMatchObject({ productId: null, categoryId: null });
  });

  it("files it under its own product and category", async () => {
    const { workspaceId, userId, services, actor } = await desk();
    const product = await addProduct(db, workspaceId, userId);
    const [category] = await categoriesOf(db, workspaceId);
    const { number } = await openTicket(services, workspaceId);
    await updateTicket(services, workspaceId, number, { productId: product.id, categoryId: category.id }, actor);
    expect(await row(workspaceId, number)).toMatchObject({ productId: product.id, categoryId: category.id });
  });

  it("says when there's no such ticket", async () => {
    const { workspaceId, services, actor } = await desk();
    expect(await updateTicket(services, workspaceId, 99, { status: "closed" }, actor)).toMatchObject({ ok: false, error: expect.stringContaining("#99") });
  });

  it("goes back to unassigned when its holder leaves, unless it had settled", async () => {
    const { workspaceId, userId, services, actor } = await desk();
    const bea = await teammate(workspaceId);
    const live = await openTicket(services, workspaceId);
    const settled = await openTicket(services, workspaceId);
    await updateTicket(services, workspaceId, live.number, { assigneeId: bea }, actor);
    await updateTicket(services, workspaceId, settled.number, { assigneeId: bea, status: "closed" }, actor);
    await removeMember(db, workspaceId, userId, bea);
    expect((await row(workspaceId, live.number)).assigneeId).toBeNull();
    expect((await row(workspaceId, settled.number)).assigneeId).toBe(bea);
  });
});

describe("bulk actions", () => {
  it("change every ticket selected, with the same record as one by one", async () => {
    const { workspaceId, services, actor } = await desk();
    const first = await openTicket(services, workspaceId);
    const second = await openTicket(services, workspaceId);
    const third = await openTicket(services, workspaceId);
    expect(await updateTickets(services, workspaceId, [first.id, second.id], { status: "closed", addTags: ["sweep"] }, actor)).toEqual({ ok: true, count: 2 });
    expect(await row(workspaceId, first.number)).toMatchObject({ status: "closed", tags: ["sweep"], resolvedAt: NOW });
    expect((await row(workspaceId, third.number)).status).toBe("open");
    expect((await ticketForTeam(db, workspaceId, second.number))?.messages.at(-1)?.body).toContain("Closed");
  });

  it("do nothing to another workspace's tickets, whatever ids they're given", async () => {
    const { workspaceId, services, actor } = await desk();
    const theirs = await desk();
    const foreign = await openTicket(theirs.services, theirs.workspaceId);
    expect(await updateTickets(services, workspaceId, [foreign.id], { status: "closed" }, actor)).toEqual({ ok: true, count: 0 });
    expect((await row(theirs.workspaceId, foreign.number)).status).toBe("open");
  });

  it("want something selected", async () => {
    const { workspaceId, services, actor } = await desk();
    expect((await updateTickets(services, workspaceId, [], { status: "closed" }, actor)).ok).toBe(false);
  });
});

describe("the inbox", () => {
  async function stocked() {
    const seat = await desk();
    const { workspaceId, userId, services, actor } = seat;
    const app = await addProduct(db, workspaceId, userId, "App");
    const shop = await addProduct(db, workspaceId, userId, "Shop", "help@shop.example");
    const [question, bug] = await categoriesOf(db, workspaceId);
    const one = await openTicket(services, workspaceId, { subject: "Login fails", product: app.slug, tags: ["vip"], priority: "urgent", category: question.name });
    const two = await openTicket(services, workspaceId, { subject: "Refund please", product: shop.slug, requester: { email: "bea@customer.example", name: "Bea Stone" }, category: bug.name });
    const three = await openTicket(services, workspaceId, { subject: "100% broken", product: app.slug });
    await updateTicket(services, workspaceId, one.number, { assigneeId: userId }, actor);
    await updateTicket(services, workspaceId, three.number, { status: "pending" }, actor);
    return { ...seat, app, shop, question, one, two, three };
  }

  it("filters by status, product, assignee, priority, category and tag", async () => {
    const { workspaceId, userId, app, question, one, two, three } = await stocked();
    const list = (filters: Parameters<typeof listTickets>[2]) => listTickets(db, workspaceId, filters).then(numbers);
    expect(await list({ status: "pending" })).toEqual([three.number]);
    expect(await list({ productId: app.id })).toEqual([one.number, three.number]);
    expect(await list({ assignee: userId })).toEqual([one.number]);
    expect(await list({ assignee: "none" })).toEqual([two.number, three.number]);
    expect(await list({ priority: "urgent" })).toEqual([one.number]);
    expect(await list({ categoryId: question.id })).toEqual([one.number]);
    expect(await list({ tag: "vip" })).toEqual([one.number]);
    expect(await list({ tag: "none" })).toEqual([]);
  });

  it("searches subjects, requesters, messages and numbers, taking % literally", async () => {
    const { workspaceId, services, actor, one, two, three } = await stocked();
    await addNote(services, workspaceId, two.number, "Spoke to finance about it", actor);
    const search = (text: string) => listTickets(db, workspaceId, { search: text }).then(numbers);
    expect(await search("login")).toEqual([one.number]);
    expect(await search("bea@customer")).toEqual([two.number]);
    expect(await search("Stone")).toEqual([two.number]);
    expect(await search("finance")).toEqual([two.number]);
    expect(await search(`#${three.number}`)).toEqual([three.number]);
    expect(await search("100%")).toEqual([three.number]);
    expect(await search("%")).toEqual([three.number]);
    expect(await search("nothing like this")).toEqual([]);
  });

  it("counts per status under the other filters, whichever status is shown", async () => {
    const { workspaceId, app } = await stocked();
    expect((await listTickets(db, workspaceId, {})).counts).toEqual({ open: 2, pending: 1, resolved: 0, closed: 0 });
    expect((await listTickets(db, workspaceId, { status: "closed" })).counts).toEqual({ open: 2, pending: 1, resolved: 0, closed: 0 });
    expect((await listTickets(db, workspaceId, { productId: app.id })).counts).toEqual({ open: 1, pending: 1, resolved: 0, closed: 0 });
    expect((await listTickets(db, workspaceId, { search: "refund" })).counts).toEqual({ open: 1, pending: 0, resolved: 0, closed: 0 });
  });

  it("shows the latest activity first, with who and what", async () => {
    const { workspaceId } = await stocked();
    const { tickets } = await listTickets(db, workspaceId, {});
    expect(tickets[0]).toMatchObject({ productName: expect.any(String), contactEmail: expect.any(String), status: expect.any(String) });
  });

  it("pages", async () => {
    const { workspaceId, services } = await desk();
    for (let index = 0; index < 51; index++) await openTicket(services, workspaceId);
    const first = await listTickets(db, workspaceId, {});
    expect(first.tickets).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    const second = await listTickets(db, workspaceId, {}, 2);
    expect(second.tickets).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });
});

describe("the inbox's address", () => {
  it("opens on what waits for the team, and reads tabs it knows", () => {
    expect(statusTab({})).toBe("open");
    expect(statusTab({ status: "all" })).toBe("all");
    expect(statusTab({ status: "closed" })).toBe("closed");
    expect(statusTab({ status: "nonsense" })).toBe("open");
  });

  it("drops what it can't mean", () => {
    expect(filtersOf({ status: "all", priority: "nonsense", product: "'; drop table ticket;--", category: "x", page: "2" }, "me")).toEqual({ status: undefined, productId: undefined, categoryId: undefined, assignee: undefined, priority: undefined, tag: undefined, search: undefined });
  });

  it("reads mine as the viewer, and keeps the rest", () => {
    const product = "11111111-1111-4111-8111-111111111111";
    expect(filtersOf({ assignee: "me", priority: "high", product, tag: "vip", q: "login" }, "viewer")).toEqual({ status: "open", productId: product, categoryId: undefined, assignee: "viewer", priority: "high", tag: "vip", search: "login" });
  });

  it("changes one thing at a time", () => {
    expect(inboxHref({ status: "open", q: "login" }, { assignee: "me" })).toBe("/tickets?status=open&q=login&assignee=me");
    expect(inboxHref({ page: "3", q: "x" }, { page: undefined })).toBe("/tickets?q=x");
    expect(inboxHref({}, {})).toBe("/tickets");
  });

  it("pages from one", () => {
    expect([pageOf({}), pageOf({ page: "3" }), pageOf({ page: "-1" }), pageOf({ page: "abc" })]).toEqual([1, 3, 1, 1]);
  });
});

describe("one ticket, as the team sees it", () => {
  it("holds everything, and the requester's other tickets", async () => {
    const { workspaceId, services, actor } = await desk();
    const first = await openTicket(services, workspaceId);
    const second = await openTicket(services, workspaceId, { subject: "Another one" });
    await addNote(services, workspaceId, first.number, "For the team", actor);
    const found = await ticketForTeam(db, workspaceId, first.number);
    expect(found?.messages.map(({ kind }) => kind)).toEqual(["customer", "note"]);
    expect(found?.messages[1].authorName).toBe("Ada");
    expect(found?.others).toMatchObject([{ number: second.number, subject: "Another one" }]);
  });

  it("isn't there for another workspace", async () => {
    const { workspaceId, services } = await desk();
    const { number } = await openTicket(services, workspaceId);
    const theirs = await desk();
    expect(await ticketForTeam(db, theirs.workspaceId, number)).toBeNull();
  });
});

describe("a note", () => {
  it("wants words and a ticket", async () => {
    const { workspaceId, services, actor } = await desk();
    const { number } = await openTicket(services, workspaceId);
    expect((await addNote(services, workspaceId, number, "  ", actor)).ok).toBe(false);
    expect((await addNote(services, workspaceId, 99, "Hello", actor)).ok).toBe(false);
  });
});

describe("opening a ticket as a member", () => {
  it("records who recorded it", async () => {
    const { workspaceId, services, userId } = await desk();
    const created = await createTicket(services, workspaceId, newTicketInput.parse({ subject: "By phone", message: "They called.", requester: { email: "ada@customer.example" } }), { channel: "web", recordedBy: { userId, writtenBy: "member" } });
    if (!created.ok) throw new Error(created.error);
    expect((await ticketForTeam(db, workspaceId, created.number))?.messages[0]).toMatchObject({ kind: "customer", authorUserId: userId, writtenBy: "member" });
  });
});

describe("finding a requester", () => {
  it("works by address, name or external id, with their tickets, and stays in its workspace", async () => {
    const { workspaceId, services } = await desk();
    await openTicket(services, workspaceId, { requester: { email: "ada@customer.example", name: "Ada Martin", externalId: "user_42" } });
    const expected = [{ email: "ada@customer.example", name: "Ada Martin", externalId: "user_42", tickets: [{ number: 1, subject: "It broke" }] }];
    expect(await findContacts(db, workspaceId, "customer.example")).toMatchObject(expected);
    expect(await findContacts(db, workspaceId, "martin")).toMatchObject(expected);
    expect(await findContacts(db, workspaceId, "user_42")).toMatchObject(expected);
    expect(await findContacts(db, workspaceId, "nobody")).toEqual([]);
    expect(await findContacts(db, (await desk()).workspaceId, "customer.example")).toEqual([]);
  });

  it("updates an external id from an app, but not a name once one is known", async () => {
    const { workspaceId, services } = await desk();
    await openTicket(services, workspaceId, { requester: { email: "ada@customer.example", name: "Ada Martin" } });
    await openTicket(services, workspaceId, { requester: { email: "ada@customer.example", name: "Someone Else", externalId: "user_7" } });
    expect(await findContacts(db, workspaceId, "ada@")).toMatchObject([{ name: "Ada Martin", externalId: "user_7" }]);
  });
});

describe("products", () => {
  it("are created with a slug and a public key, and renamed without losing the slug", async () => {
    const { workspaceId, userId } = await desk();
    expect(await createProduct(db, workspaceId, userId, { name: "Acme App!", colour: "#112233", supportAddress: "Support@Acme.Example", senderName: "Acme\r\nsupport" })).toMatchObject({ ok: true });
    const [created] = await productsOf(db, workspaceId);
    expect(created).toMatchObject({ slug: "acme-app", colour: "#112233", supportAddress: "support@acme.example", senderName: "Acme support" });
    expect(created.publicKey).toMatch(/^pk_[\w-]{32}$/);
    expect(await updateProduct(db, workspaceId, userId, created.id, { name: "Renamed", supportAddress: "" })).toMatchObject({ ok: true });
    expect((await productsOf(db, workspaceId))[0]).toMatchObject({ name: "Renamed", slug: "acme-app", supportAddress: null });
  });

  it("refuse a bad name, colour or address, and a name already taken", async () => {
    const { workspaceId, userId } = await desk();
    await addProduct(db, workspaceId, userId, "Taken");
    for (const values of [{ name: " " }, { name: "A", colour: "red; background:url(x)" }, { name: "A", supportAddress: "nope" }, { name: "Taken" }]) expect((await createProduct(db, workspaceId, userId, values)).ok).toBe(false);
  });

  it("are changed by an owner or admin only, since their address is what leaves in the company's name", async () => {
    const { workspaceId, userId } = await desk();
    const product = await addProduct(db, workspaceId, userId);
    const plain = await teammate(workspaceId);
    expect((await createProduct(db, workspaceId, plain, { name: "Mine" })).ok).toBe(false);
    expect((await updateProduct(db, workspaceId, plain, product.id, { name: "Mine" })).ok).toBe(false);
    expect(await deleteProduct(db, workspaceId, plain, product.id)).toBe(false);
    expect(await renewPublicKey(db, workspaceId, plain, product.id)).toBe(false);
    const admin = await teammate(workspaceId, "admin");
    expect((await updateProduct(db, workspaceId, admin, product.id, { name: "Theirs" })).ok).toBe(true);
  });

  it("leave their tickets behind when deleted", async () => {
    const { workspaceId, userId, services } = await desk();
    const product = await addProduct(db, workspaceId, userId);
    const { number } = await openTicket(services, workspaceId, { product: product.slug });
    expect(await deleteProduct(db, workspaceId, userId, product.id)).toBe(true);
    expect((await row(workspaceId, number)).productId).toBeNull();
  });

  it("aren't reached from another workspace", async () => {
    const { workspaceId, userId } = await desk();
    const theirs = await desk();
    const product = await addProduct(db, theirs.workspaceId, theirs.userId);
    expect((await updateProduct(db, workspaceId, userId, product.id, { name: "Stolen" })).ok).toBe(false);
    expect(await deleteProduct(db, workspaceId, userId, product.id)).toBe(false);
    expect(await renewPublicKey(db, workspaceId, userId, product.id)).toBe(false);
    expect((await productsOf(db, theirs.workspaceId))[0].name).toBe("Acme App");
  });
});

describe("categories and saved replies", () => {
  it("are added once each, and removed", async () => {
    const { workspaceId, userId, services } = await desk();
    expect((await addCategory(db, workspaceId, "  Refunds ")).ok).toBe(true);
    expect((await addCategory(db, workspaceId, "Refunds")).ok).toBe(false);
    expect((await addCategory(db, workspaceId, "  ")).ok).toBe(false);
    const categories = await categoriesOf(db, workspaceId);
    const refunds = categories.find(({ name }) => name === "Refunds");
    expect(categories.at(-1)?.name).toBe("Refunds");
    const { number } = await openTicket(services, workspaceId, { category: "Refunds" });
    expect(await removeCategory(db, workspaceId, refunds?.id as string)).toBe(true);
    expect((await row(workspaceId, number)).categoryId).toBeNull();

    expect((await addSavedReply(db, workspaceId, userId, "Reset", "Use the reset link.")).ok).toBe(true);
    expect((await addSavedReply(db, workspaceId, userId, "Reset", "Again")).ok).toBe(false);
    expect((await addSavedReply(db, workspaceId, userId, " ", "No title")).ok).toBe(false);
    expect((await addSavedReply(db, workspaceId, userId, "Empty", " ")).ok).toBe(false);
    const [saved] = await savedRepliesOf(db, workspaceId);
    expect(saved).toMatchObject({ title: "Reset", body: "Use the reset link." });
    expect(await removeSavedReply(db, workspaceId, saved.id)).toBe(true);
    expect(await removeSavedReply(db, workspaceId, saved.id)).toBe(false);
  });
});
