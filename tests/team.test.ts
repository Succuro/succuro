import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { accessOfKey, createApiKey, createReadKey } from "@/application/api-keys";
import { changeRole, removeMember, roleIn, teamOf } from "@/application/team";
import { workspacesOf } from "@/application/workspaces";
import { INVITATION_REFUSALS, managesTeam, refusalToChangeRole, refusalToLeave, refusalToRemove, type Teammate } from "@/domain/team";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { connection } from "@/infrastructure/db/schema/connections";
import { contact, ticket } from "@/infrastructure/db/schema/support";
import { member } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";

const TEAM: Teammate[] = [
  { userId: "owner", role: "owner" },
  { userId: "admin", role: "admin" },
  { userId: "other-admin", role: "admin" },
  { userId: "member", role: "member" },
];

const TWO_OWNERS: Teammate[] = [...TEAM, { userId: "second-owner", role: "owner" }];

describe("who runs a team", () => {
  it("is its owners and admins", () => {
    expect(["owner", "admin", "member", undefined].map((role) => managesTeam(role as never))).toEqual([true, true, false, false]);
  });

  it("refuses a plain member, and someone who isn't there", () => {
    for (const actor of ["member", "stranger"]) {
      expect(refusalToRemove(TEAM, actor, "admin")).toContain("run the team");
      expect(refusalToChangeRole(TEAM, actor, "member", "admin")).toContain("run the team");
      expect(refusalToChangeRole(TEAM, actor, actor, "owner")).toContain("run the team");
    }
  });

  it("lets an admin run members and other admins, but not owners", () => {
    expect(refusalToRemove(TEAM, "admin", "member")).toBeNull();
    expect(refusalToRemove(TEAM, "admin", "other-admin")).toBeNull();
    expect(refusalToChangeRole(TEAM, "admin", "member", "admin")).toBeNull();
    expect(refusalToChangeRole(TWO_OWNERS, "admin", "second-owner", "member")).toContain("owner");
    expect(refusalToRemove(TWO_OWNERS, "admin", "second-owner")).toContain("owner");
  });

  it("doesn't let an admin name an owner, themselves least of all", () => {
    expect(refusalToChangeRole(TEAM, "admin", "admin", "owner")).toContain("owner");
    expect(refusalToChangeRole(TEAM, "admin", "member", "owner")).toContain("owner");
    expect(refusalToChangeRole(TEAM, "owner", "admin", "owner")).toBeNull();
  });

  it("says when the person is no longer there", () => {
    expect(refusalToRemove(TEAM, "owner", "gone")).toContain("no longer");
    expect(refusalToChangeRole(TEAM, "owner", "gone", "admin")).toContain("no longer");
  });
});

describe("the last owner", () => {
  it("can't be removed, demoted or leave", () => {
    expect(refusalToRemove(TEAM, "owner", "owner")).toContain("always keeps an owner");
    expect(refusalToChangeRole(TEAM, "owner", "owner", "admin")).toContain("always keeps an owner");
    expect(refusalToLeave(TEAM, "owner")).toContain("always keeps an owner");
  });

  it("can keep their role, which changes nothing", () => {
    expect(refusalToChangeRole(TEAM, "owner", "owner", "owner")).toBeNull();
  });

  it("is free once there's another", () => {
    expect(refusalToLeave(TWO_OWNERS, "owner")).toBeNull();
    expect(refusalToChangeRole(TWO_OWNERS, "owner", "owner", "member")).toBeNull();
    expect(refusalToRemove(TWO_OWNERS, "owner", "second-owner")).toBeNull();
  });

  it("doesn't stop anyone else leaving", () => {
    expect(refusalToLeave(TEAM, "member")).toBeNull();
    expect(refusalToRemove(TEAM, "member", "member")).toBeNull();
    expect(refusalToRemove(TEAM, "admin", "admin")).toBeNull();
  });
});

describe("what a team says", () => {
  it("names nobody", () => {
    const refusals = [refusalToRemove(TEAM, "member", "admin"), refusalToRemove(TEAM, "owner", "owner"), refusalToRemove(TWO_OWNERS, "admin", "owner"), refusalToRemove(TEAM, "owner", "gone"), ...Object.values(INVITATION_REFUSALS)];
    for (const refusal of refusals) for (const id of ["member", "admin", "gone"]) expect(refusal).not.toContain(`"${id}"`);
  });
});

describe("a workspace's team", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDatabase();
  });

  /** A workspace with its owner and, joining them, someone in the role asked for. */
  async function withMate(role: "owner" | "admin" | "member" = "member") {
    const { workspaceId, userId: ownerId } = await createTestWorkspace(db, "Team");
    const mateId = crypto.randomUUID();
    await db.insert(user).values({ id: mateId, name: "Bea", email: `${mateId}@example.test` });
    await db.insert(member).values({ workspaceId, userId: mateId, role });
    return { workspaceId, ownerId, mateId };
  }

  it("lists its people with their roles, the first to join first", async () => {
    const { workspaceId, ownerId, mateId } = await withMate("admin");
    expect(await teamOf(db, workspaceId)).toEqual([
      { userId: ownerId, role: "owner", name: "Ada", email: `${ownerId}@example.test` },
      { userId: mateId, role: "admin", name: "Bea", email: `${mateId}@example.test` },
    ]);
  });

  it("takes someone out, and their access with it", async () => {
    const { workspaceId, ownerId, mateId } = await withMate();
    expect(await removeMember(db, workspaceId, ownerId, mateId)).toMatchObject({ ok: true });
    expect(await workspacesOf(db, mateId)).toEqual([]);
    expect(await roleIn(db, workspaceId, mateId)).toBeUndefined();
  });

  it("refuses a plain member removing or promoting anyone, themselves included, and changes nothing", async () => {
    const { workspaceId, ownerId, mateId } = await withMate();
    expect((await removeMember(db, workspaceId, mateId, ownerId)).ok).toBe(false);
    expect((await changeRole(db, workspaceId, mateId, mateId, "owner")).ok).toBe(false);
    expect(await roleIn(db, workspaceId, ownerId)).toBe("owner");
    expect(await roleIn(db, workspaceId, mateId)).toBe("member");
  });

  it("keeps its last owner, whoever tries", async () => {
    const { workspaceId, ownerId, mateId } = await withMate("admin");
    expect((await removeMember(db, workspaceId, ownerId, ownerId)).ok).toBe(false);
    expect((await changeRole(db, workspaceId, ownerId, ownerId, "member")).ok).toBe(false);
    expect((await removeMember(db, workspaceId, mateId, ownerId)).ok).toBe(false);
    expect((await changeRole(db, workspaceId, mateId, ownerId, "member")).ok).toBe(false);
    expect(await roleIn(db, workspaceId, ownerId)).toBe("owner");
  });

  it("hands ownership over, and only then frees the first owner", async () => {
    const { workspaceId, ownerId, mateId } = await withMate();
    expect(await changeRole(db, workspaceId, ownerId, mateId, "owner")).toMatchObject({ ok: true });
    expect(await changeRole(db, workspaceId, ownerId, ownerId, "member")).toMatchObject({ ok: true });
    expect(await roleIn(db, workspaceId, ownerId)).toBe("member");
    expect((await changeRole(db, workspaceId, mateId, mateId, "member")).ok).toBe(false);
  });

  it("never lets two owners both go at once", async () => {
    const { workspaceId, ownerId, mateId } = await withMate("owner");
    const results = await Promise.all([changeRole(db, workspaceId, ownerId, mateId, "member"), changeRole(db, workspaceId, mateId, ownerId, "member")]);
    const owners = (await teamOf(db, workspaceId)).filter(({ role }) => role === "owner");
    expect(owners).toHaveLength(1);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
  });

  it("lets a member leave, and refuses the last owner", async () => {
    const { workspaceId, ownerId, mateId } = await withMate();
    expect(await removeMember(db, workspaceId, mateId, mateId)).toMatchObject({ ok: true, said: "You left this workspace." });
    expect((await removeMember(db, workspaceId, ownerId, ownerId)).ok).toBe(false);
  });

  it("stays out of other workspaces: an owner elsewhere is nobody here", async () => {
    const { workspaceId, mateId } = await withMate();
    const elsewhere = await createTestWorkspace(db, "Elsewhere");
    expect((await removeMember(db, workspaceId, elsewhere.userId, mateId)).ok).toBe(false);
    expect((await changeRole(db, workspaceId, elsewhere.userId, mateId, "owner")).ok).toBe(false);
    expect(await roleIn(db, workspaceId, mateId)).toBe("member");
  });

  it("removes someone from this workspace only", async () => {
    const { workspaceId, ownerId, mateId } = await withMate();
    const theirs = await createTestWorkspace(db, "Theirs");
    await db.insert(member).values({ workspaceId: theirs.workspaceId, userId: mateId, role: "member" });
    await removeMember(db, workspaceId, ownerId, mateId);
    expect((await workspacesOf(db, mateId)).map(({ id }) => id)).toEqual([theirs.workspaceId]);
  });

  describe("what someone leaving was holding", () => {
    async function holding() {
      const seats = await withMate();
      const { workspaceId, mateId } = seats;
      const ids = await withWorkspace(db, workspaceId, async (tx) => {
        const [person] = await tx.insert(contact).values({ email: "ada@customer.example" }).returning();
        const held = { contactId: person.id, channel: "api" as const, subject: "Theirs", lastMessageAt: new Date(), assigneeId: mateId };
        const [open] = await tx.insert(ticket).values({ ...held, number: 1, replyToken: "a", status: "open" }).returning();
        const [settled] = await tx.insert(ticket).values({ ...held, number: 2, replyToken: "b", status: "closed" }).returning();
        const [mail] = await tx.insert(connection).values({ kind: "resend", label: "Resend", sealedCredentials: "sealed", hookToken: "hook", connectedBy: mateId }).returning();
        return { openId: open.id, settledId: settled.id, mailId: mail.id };
      });
      return { ...seats, ...ids };
    }

    const heldBy = (workspaceId: string, ids: Awaited<ReturnType<typeof holding>>) =>
      withWorkspace(db, workspaceId, async (tx) => ({
        open: (await tx.select({ by: ticket.assigneeId }).from(ticket).where(eq(ticket.id, ids.openId)))[0].by,
        settled: (await tx.select({ by: ticket.assigneeId }).from(ticket).where(eq(ticket.id, ids.settledId)))[0].by,
        mail: (await tx.select({ by: connection.connectedBy }).from(connection).where(eq(connection.id, ids.mailId)))[0].by,
      }));

    it("goes back where the team looks: tickets in play to nobody, the connection to an owner; what they settled stays theirs", async () => {
      const ids = await holding();
      await removeMember(db, ids.workspaceId, ids.ownerId, ids.mateId);
      expect(await heldBy(ids.workspaceId, ids)).toEqual({ open: null, settled: ids.mateId, mail: ids.ownerId });
    });

    it("stays with them when they can't go", async () => {
      const ids = await holding();
      await removeMember(db, ids.workspaceId, ids.mateId, ids.ownerId);
      expect(await heldBy(ids.workspaceId, ids)).toEqual({ open: ids.mateId, settled: ids.mateId, mail: ids.mateId });
    });
  });
});

describe("the keys of someone leaving", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDatabase();
  });

  async function madeKey(workspaceId: string, userId: string, name = "Dashboard") {
    const made = await createReadKey(db, workspaceId, userId, name);
    if (!made.ok) throw new Error(made.error);
    return made.key;
  }
  const opens = async (key: string) => (await accessOfKey(db, key, "figures:read")).status;

  async function withAdmin() {
    const { workspaceId, userId: ownerId } = await createTestWorkspace(db);
    const adminId = crypto.randomUUID();
    await db.insert(user).values({ id: adminId, name: "Bea", email: `${adminId}@example.test` });
    await db.insert(member).values({ workspaceId, userId: adminId, role: "admin" });
    return { workspaceId, ownerId, adminId };
  }

  it("stop working when they're removed, made on the screen or by their assistant, and the removal says so", async () => {
    const { workspaceId, ownerId, adminId } = await withAdmin();
    const onScreen = await createApiKey(db, workspaceId, adminId, "From the screen", ["figures:read", "tickets:create"]);
    if (!onScreen.ok) throw new Error(onScreen.error);
    const byAssistant = await madeKey(workspaceId, adminId, "From an assistant");
    expect(await opens(onScreen.key)).toBe("ok");
    expect(await opens(byAssistant)).toBe("ok");
    const removed = await removeMember(db, workspaceId, ownerId, adminId);
    expect(removed).toMatchObject({ ok: true, said: expect.stringContaining("API keys") });
    expect(await opens(onScreen.key)).toBe("unknown");
    expect(await opens(byAssistant)).toBe("unknown");
  });

  it("stop working when they leave by themselves", async () => {
    const { workspaceId, adminId } = await withAdmin();
    const key = await madeKey(workspaceId, adminId);
    expect((await removeMember(db, workspaceId, adminId, adminId)).ok).toBe(true);
    expect(await opens(key)).toBe("unknown");
  });

  it("leave everyone else's alone, and their own in a workspace they stay in", async () => {
    const { workspaceId, ownerId, adminId } = await withAdmin();
    const owners = await madeKey(workspaceId, ownerId);
    const { workspaceId: elsewhere, userId: otherOwner } = await createTestWorkspace(db);
    await db.insert(member).values({ workspaceId: elsewhere, userId: adminId, role: "admin" });
    const theirsElsewhere = await madeKey(elsewhere, adminId);
    const removed = await removeMember(db, workspaceId, ownerId, adminId);
    expect(removed).toEqual({ ok: true, said: "This person no longer has access to this workspace." });
    expect(await opens(owners)).toBe("ok");
    expect(await opens(theirsElsewhere)).toBe("ok");
    expect(await roleIn(db, elsewhere, otherOwner)).toBe("owner");
  });

  it("survive a removal that was refused", async () => {
    const { workspaceId, ownerId, adminId } = await withAdmin();
    const key = await madeKey(workspaceId, ownerId);
    expect((await removeMember(db, workspaceId, ownerId, ownerId)).ok).toBe(false);
    expect((await removeMember(db, workspaceId, adminId, ownerId)).ok).toBe(false);
    expect(await opens(key)).toBe("ok");
  });
});
