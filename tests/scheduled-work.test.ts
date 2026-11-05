import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cron/stuck-replies/route";
import { replyNow } from "@/application/replies";
import { failStuckReplies, whatIsScheduled } from "@/application/scheduled-work";
import type { Database } from "@/infrastructure/db/client";
import { message } from "@/infrastructure/db/schema/support";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { SCHEDULED_WORK_TAG, scheduledWorkChanged } from "@/infrastructure/scheduling/scheduled-work";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { addProduct, connectResend, NOW, openTicket, testServices } from "./support/desk";

const revalidateTag = vi.hoisted(() => vi.fn());
const shared = vi.hoisted(() => ({ db: undefined as unknown, cached: undefined as unknown, secret: "cron-secret" as string | undefined }));
vi.mock("next/cache", () => ({ revalidateTag, cacheLife: () => {}, cacheTag: () => {} }));
vi.mock("@/infrastructure/db/client", async (original) => ({ ...(await original<typeof import("@/infrastructure/db/client")>()), db: () => shared.db }));
vi.mock("@/infrastructure/env", async (original) => ({ ...(await original<typeof import("@/infrastructure/env")>()), env: () => ({ CRON_SECRET: shared.secret }) }));

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
  shared.db = db;
});
beforeEach(async () => {
  revalidateTag.mockReset();
  await db.delete(message);
});

/** A reply caught mid-send: marked as sending, and whatever was sending it gone. */
async function inFlight(stuckSince = NOW) {
  const { workspaceId, userId } = await createTestWorkspace(db);
  const { services } = testServices(db);
  const product = await addProduct(db, workspaceId, userId);
  await connectResend(services, workspaceId, userId);
  const { number } = await openTicket(services, workspaceId, { product: product.slug });
  await replyNow(services, workspaceId, number, "Hello", { userId, writtenBy: "member" });
  await withWorkspace(db, workspaceId, (tx) => tx.update(message).set({ deliveryState: "sending", updatedAt: stuckSince }).where(eq(message.kind, "agent")));
  const state = async () => (await withWorkspace(db, workspaceId, (tx) => tx.select().from(message).where(eq(message.kind, "agent"))))[0];
  return { state };
}

describe("what the scheduled job has to do", () => {
  it("is nothing while no reply is in flight", async () => {
    expect(await whatIsScheduled(db)).toEqual({ repliesInFlight: false });
  });

  it("is something once one is, in any workspace", async () => {
    await inFlight();
    expect(await whatIsScheduled(db)).toEqual({ repliesInFlight: true });
  });
});

describe("what's known about it", () => {
  it("is cleared at once, so a run started right after doesn't read the old answer", () => {
    scheduledWorkChanged();
    expect(revalidateTag).toHaveBeenCalledWith(SCHEDULED_WORK_TAG, { expire: 0 });
  });

  it("doesn't stop anything outside a request, where nothing is cached to clear", () => {
    revalidateTag.mockImplementation(() => {
      throw new Error("Invariant: static generation store missing");
    });
    expect(() => scheduledWorkChanged()).not.toThrow();
  });
});

describe("a reply whose sending died", () => {
  it("becomes a failure a member can see, once it's been long enough", async () => {
    const { state } = await inFlight(new Date(NOW.getTime() - 16 * 60_000));
    expect(await failStuckReplies(db, NOW)).toBe(1);
    expect(await state()).toMatchObject({ deliveryState: "failed", deliveryError: expect.stringContaining("can’t tell whether it left") });
    expect(await whatIsScheduled(db)).toEqual({ repliesInFlight: false });
  });

  it("isn't touched while it may still be running", async () => {
    const { state } = await inFlight(new Date(NOW.getTime() - 60_000));
    expect(await failStuckReplies(db, NOW)).toBe(0);
    expect((await state()).deliveryState).toBe("sending");
  });

  it("clears what's known afterwards, so the next run asks", async () => {
    await inFlight(new Date(NOW.getTime() - 16 * 60_000));
    revalidateTag.mockClear();
    await failStuckReplies(db, NOW);
    expect(revalidateTag).toHaveBeenCalledWith(SCHEDULED_WORK_TAG, { expire: 0 });
  });
});

describe("the job's address", () => {
  const call = (authorization?: string) => GET(new Request("https://succuro.test/api/cron/stuck-replies", { headers: authorization ? { authorization } : {} }));

  it("is for the scheduler only", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    shared.secret = undefined;
    expect((await call("Bearer anything")).status).toBe(401);
    shared.secret = "cron-secret";
  });

  it("does its work when a reply is stuck", async () => {
    await inFlight(new Date(Date.now() - 16 * 60_000));
    expect(await (await call("Bearer cron-secret")).json()).toEqual({ failed: 1 });
  });
});
