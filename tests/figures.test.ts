import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { figuresOf } from "@/application/figures";
import { daysEndingAt, daysOfProduct } from "@/domain/figures";
import type { Database } from "@/infrastructure/db/client";
import { ticket } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { addProduct, openTicket, testServices } from "./support/desk";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

const NOW = new Date("2026-11-05T09:00:00Z");
const at = (text: string) => new Date(text);

describe("the days of a period", () => {
  it("end today, in UTC, oldest first", () => {
    expect(daysEndingAt(NOW, 3)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
    expect(daysEndingAt(at("2026-11-05T23:59:59+09:00"), 1)).toEqual(["2026-11-05"]);
  });

  it("carry the backlog from one to the next", () => {
    const days = daysOfProduct(
      {
        productId: "p",
        backlogBefore: 2,
        opened: [{ productId: "p", date: "2026-11-03", count: 3 }],
        resolved: [{ productId: "p", date: "2026-11-05", count: 4, seconds: 60 }],
        firstResponses: [{ productId: "p", date: "2026-11-03", count: 1, seconds: 30 }],
      },
      ["2026-11-03", "2026-11-04", "2026-11-05"],
    );
    expect(days).toEqual([
      { date: "2026-11-03", opened: 3, resolved: 0, firstResponseSeconds: 30, resolutionSeconds: null, backlog: 5 },
      { date: "2026-11-04", opened: 0, resolved: 0, firstResponseSeconds: null, resolutionSeconds: null, backlog: 5 },
      { date: "2026-11-05", opened: 0, resolved: 4, firstResponseSeconds: null, resolutionSeconds: 60, backlog: 1 },
    ]);
  });
});

describe("a workspace's figures", () => {
  async function scene() {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = testServices(db);
    const product = await addProduct(db, workspaceId, userId);
    const set = (number: number, values: Partial<typeof ticket.$inferInsert>) => withWorkspace(db, workspaceId, (tx) => tx.update(ticket).set(values).where(eq(ticket.number, number)));
    const opened = async (values: Partial<typeof ticket.$inferInsert>) => {
      const { number } = await openTicket(services, workspaceId, { product: product.slug });
      await set(number, values);
    };
    return { workspaceId, opened, product, services, set };
  }

  it("count what opened and what resolved, per day, with median times", async () => {
    const { workspaceId, opened, product } = await scene();
    await opened({ createdAt: at("2026-11-04T08:00:00Z"), firstResponseAt: at("2026-11-04T08:10:00Z"), resolvedAt: at("2026-11-05T08:00:00Z"), status: "resolved" });
    await opened({ createdAt: at("2026-11-04T09:00:00Z"), firstResponseAt: at("2026-11-04T09:30:00Z") });
    await opened({ createdAt: at("2026-11-04T10:00:00Z"), firstResponseAt: at("2026-11-04T11:00:00Z") });
    const { from, to, timezone, products } = await figuresOf(db, workspaceId, { days: 2, now: NOW });
    expect({ from, to, timezone }).toEqual({ from: "2026-11-04", to: "2026-11-05", timezone: "UTC" });
    expect(products).toEqual([
      {
        slug: product.slug,
        name: product.name,
        days: [
          { date: "2026-11-04", opened: 3, resolved: 0, firstResponseSeconds: 1800, resolutionSeconds: null, backlog: 3 },
          { date: "2026-11-05", opened: 0, resolved: 1, firstResponseSeconds: null, resolutionSeconds: 86_400, backlog: 2 },
        ],
      },
    ]);
  });

  it("start the backlog from what was already open", async () => {
    const { workspaceId, opened, product } = await scene();
    await opened({ createdAt: at("2026-10-01T08:00:00Z") });
    await opened({ createdAt: at("2026-10-01T08:00:00Z"), resolvedAt: at("2026-10-02T08:00:00Z"), status: "closed" });
    await opened({ createdAt: at("2026-10-01T08:00:00Z"), resolvedAt: at("2026-11-05T08:00:00Z"), status: "closed" });
    const { products } = await figuresOf(db, workspaceId, { days: 2, now: NOW });
    const line = products.find(({ slug }) => slug === product.slug);
    expect(line?.days.map(({ backlog }) => backlog)).toEqual([2, 1]);
  });

  it("keep tickets without a product on a line of their own", async () => {
    const { workspaceId, services, set } = await scene();
    const { number } = await openTicket(services, workspaceId);
    await set(number, { createdAt: at("2026-11-05T08:00:00Z") });
    const { products } = await figuresOf(db, workspaceId, { days: 1, now: NOW });
    expect(products.find(({ slug }) => slug === null)).toEqual({ slug: null, name: "No product", days: [expect.objectContaining({ opened: 1, backlog: 1 })] });
  });

  it("don't mention what isn't asked, or what isn't there", async () => {
    const { workspaceId } = await scene();
    expect((await figuresOf(db, workspaceId, { days: 1, now: NOW, productSlug: "no-such" })).products).toEqual([]);
    expect((await figuresOf(db, workspaceId, { days: 1, now: NOW })).products).toHaveLength(1);
  });

  it("stay in their workspace", async () => {
    const mine = await scene();
    const theirs = await scene();
    await theirs.opened({ createdAt: at("2026-11-05T08:00:00Z") });
    const { products } = await figuresOf(db, mine.workspaceId, { days: 1, now: NOW });
    expect(products[0].days[0].opened).toBe(0);
  });
});
