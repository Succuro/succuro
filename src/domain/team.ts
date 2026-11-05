/** Who may do what in a workspace's team. Being in a workspace is what opens its data; the role only says who runs it. */

export type Role = "owner" | "admin" | "member";

export const ROLES = ["owner", "admin", "member"] as const satisfies readonly Role[];

export const ROLE_NAMES: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** What an invitation can make someone. Ownership is handed over by an owner, to someone already there. */
export const INVITABLE_ROLES = ["admin", "member"] as const satisfies readonly Role[];

export interface Teammate {
  userId: string;
  role: Role;
}

export const managesTeam = (role: Role | undefined) => role === "owner" || role === "admin";

/** The settings that decide what leaves in the workspace's name: credentials, keys, whether an assistant may send. */
export const managesSettings = managesTeam;

export const NOT_A_MANAGER_OF_SETTINGS = "Only owners and admins can change this.";

const NOT_A_MANAGER = "Only owners and admins run the team.";
const OWNERS_ONLY = "Only an owner can name, change or remove an owner.";
const LAST_OWNER = "A workspace always keeps an owner: name another one first.";
const NOT_THERE = "This person is no longer in this workspace.";

const roleOf = (team: Teammate[], userId: string) => team.find((teammate) => teammate.userId === userId)?.role;
const isLastOwner = (team: Teammate[], userId: string) => roleOf(team, userId) === "owner" && team.filter(({ role }) => role === "owner").length === 1;

/** Admins run the team but not its owners: otherwise an admin could name themselves owner and remove the one who invited them. */
function refusalToManage(team: Teammate[], actorId: string, targetId: string): string | null {
  const actor = roleOf(team, actorId);
  const target = roleOf(team, targetId);
  if (!managesTeam(actor)) return NOT_A_MANAGER;
  if (!target) return NOT_THERE;
  if (target === "owner" && actor !== "owner") return OWNERS_ONLY;
  return isLastOwner(team, targetId) ? LAST_OWNER : null;
}

/** Anyone may leave, except the workspace's last owner: it would belong to nobody. */
export const refusalToLeave = (team: Teammate[], userId: string): string | null => (isLastOwner(team, userId) ? LAST_OWNER : null);

export const refusalToRemove = (team: Teammate[], actorId: string, targetId: string): string | null => (actorId === targetId ? refusalToLeave(team, actorId) : refusalToManage(team, actorId, targetId));

export function refusalToChangeRole(team: Teammate[], actorId: string, targetId: string, role: Role): string | null {
  const actor = roleOf(team, actorId);
  if (!managesTeam(actor)) return NOT_A_MANAGER;
  if (role === roleOf(team, targetId)) return null;
  if (role === "owner" && actor !== "owner") return OWNERS_ONLY;
  return refusalToManage(team, actorId, targetId);
}

/** Why an invitation link doesn't let someone in. It names nobody and no workspace: whoever holds the link may be anyone. */
export const INVITATION_REFUSALS = {
  unknown: "This link isn’t valid, or the invitation was cancelled.",
  used: "This invitation has already been used.",
  expired: "This invitation has expired: ask the person who sent it for a new one.",
  other_address: "This invitation was sent to a different address than your account’s. Sign in with the address that received it.",
} as const;

export type InvitationRefusal = keyof typeof INVITATION_REFUSALS;
