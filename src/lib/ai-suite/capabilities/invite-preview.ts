import "server-only";

import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { resolvePlatformSender } from "@/lib/comms/platform-email";
import { oneLine } from "./text-safety";
import { CapabilityUserError, type PreviewRow } from "./types";

/**
 * What `invite_member` would do for an email in a sub-account, read live the
 * way `createInviteServerSide` decides it (members-service.ts): a verified
 * account (or one already an active member) is added directly; anything
 * else gets a pending invite, re-using one that is already pending. The
 * approver sees it before anything happens (AGENCY_AGENT_API_PLAN.md A4b),
 * and it is pinned, so a change before or after the approve claim refuses.
 * An account the service would refuse (disabled, another agency's) is a
 * row too, whose approval refuses: the proposing key can't tell it apart
 * from any other address (only the approver reads the rows past
 * AGENT_PREVIEW_LABELS).
 */

export type InviteState =
  | { kind: "new" }
  | { kind: "pending"; role: string; territoryIds: string[] }
  | { kind: "account"; uid: string }
  | { kind: "member"; uid: string; role: string; territoryIds: string[] }
  | { kind: "former_member"; uid: string; role: string; territoryIds: string[] }
  | { kind: "blocked"; reason: string };

/** The rows the proposing agent gets back: nothing about the account. */
export const AGENT_PREVIEW_LABELS = ["Sub-account", "Email", "Role"] as const;

const ROLE = {
  admin: "Admin: manages members and settings",
  collaborator: "Collaborator: works the data, no member management",
} as const;

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : []);

/** Sub-account `subAccountId`'s state for `email` (already lowercased). The
 *  agency is the sub-account's own, as createInviteServerSide reads it. */
export async function inviteState(subAccountId: string, email: string): Promise<InviteState> {
  const db = getAdminDb();
  const agencyId = (await db.doc(`subAccounts/${subAccountId}`).get()).data()?.agencyId;
  let user: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["getUserByEmail"]>> | null = null;
  try {
    user = await getAdminAuth().getUserByEmail(email);
  } catch (err) {
    if ((err as { code?: string }).code !== "auth/user-not-found") throw err;
  }
  const member = user ? (await db.doc(`subAccounts/${subAccountId}/subAccountMembers/${user.uid}`).get()).data() : undefined;
  if (user && (user.emailVerified || member?.status === "active")) {
    const claims = (user.customClaims ?? {}) as { agencyId?: string; status?: string };
    // The cases createInviteServerSide refuses (MemberAddBlockedError).
    if (user.disabled || claims.status === "removed") {
      return { kind: "blocked", reason: "This person's account was removed or disabled. Reactivate it before adding them to a workspace." };
    }
    if (claims.agencyId && claims.agencyId !== agencyId) {
      return { kind: "blocked", reason: "This email belongs to a different agency and can't be added to this workspace." };
    }
    if (!member) return { kind: "account", uid: user.uid };
    const role = String(member.role ?? "member");
    const territoryIds = ids(member.assignedTerritoryIds);
    return member.status === "active"
      ? { kind: "member", uid: user.uid, role, territoryIds }
      : { kind: "former_member", uid: user.uid, role, territoryIds };
  }
  const pending = await db
    .collection("invites")
    .where("email", "==", email)
    .where("subAccountId", "==", subAccountId)
    .where("acceptedByUid", "==", null)
    .where("revokedAt", "==", null)
    .limit(1)
    .get();
  if (pending.empty) return { kind: "new" };
  const invite = pending.docs[0]!.data();
  return { kind: "pending", role: String(invite.subAccountRole ?? "collaborator"), territoryIds: ids(invite.assignedTerritoryIds) };
}

/** The territory ids an existing membership or pending invite has now. */
const existingTerritories = (state: InviteState): string[] => ("territoryIds" in state ? state.territoryIds : []);

/**
 * The territories createInviteServerSide will leave on the invite or
 * membership, decided as it decides them (validateTerritoryIds): a
 * collaborator keeps the distinct ids, at most 30, that are active
 * territories now; an admin keeps none. Pinned, so an archive after the
 * claim refuses instead of dropping one silently.
 */
export async function keptTerritories(
  subAccountId: string,
  state: InviteState,
  role: string
): Promise<{ ids: string[]; names: string[]; dropped: number }> {
  const had = [...new Set(existingTerritories(state))];
  const wanted = had.slice(0, 30);
  if (role !== "collaborator" || wanted.length === 0) return { ids: [], names: [], dropped: had.length };
  const db = getAdminDb();
  const snaps = await db.getAll(...wanted.map((t) => db.doc(`subAccounts/${subAccountId}/territories/${t}`)));
  const active = snaps.filter((s) => s.exists && s.data()?.status === "active");
  return { ids: active.map((s) => s.id), names: active.map((s) => oneLine(s.data()?.name ?? s.id)), dropped: had.length - active.length };
}

/** The "What happens" line for a state. */
function happens(state: InviteState, role: string): string {
  switch (state.kind) {
    case "new":
      return "New email: an invite with a signup link is created; pending until they sign up.";
    case "pending":
      return `Already invited as ${state.role}: the pending invite ${state.role === role ? "stays" : "becomes"} ${role} and is re-sent with a new link (the old link stops working).`;
    case "account":
      return "Existing account: added immediately, nothing to accept.";
    case "member":
      return state.role === role
        ? `Already a member: no change (role stays ${role}).`
        : `Already a member: role ${state.role} → ${role}, at once.`;
    case "former_member":
      return `Former member (was ${state.role}): re-added immediately as ${role}, nothing to accept.`;
    case "blocked":
      return `Approving will be refused: ${state.reason}`;
  }
}

/** What the invite or membership's territories will be. */
function territoriesRow(state: InviteState, role: string, kept: { names: string[]; dropped: number }): PreviewRow[] {
  const had = existingTerritories(state).length > 0;
  if (role === "admin") return had ? [{ label: "Territories", value: "Cleared: an admin sees every territory." }] : [];
  if (state.kind === "blocked") return [];
  const value = kept.names.length
    ? `Kept: ${kept.names.join(", ")}${kept.dropped ? `; ${kept.dropped} not kept (archived, deleted or over the 30 limit)` : ""}.`
    : `None assigned: with territory scoping on, they see only records in no territory (global).${
        kept.dropped ? ` ${kept.dropped} assigned now ${kept.dropped === 1 ? "is" : "are"} archived or deleted.` : ""
      }`;
  return [{ label: "Territories", value }];
}

/** The approver's rows and the pins for an invite of `email` as `role`. */
export async function invitePreview(
  subAccountId: string,
  agencyId: string,
  email: string,
  role: "admin" | "collaborator"
): Promise<{ rows: PreviewRow[]; pinned: Record<string, unknown> }> {
  const sub = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!sub.exists || sub.data()?.agencyId !== agencyId) throw new CapabilityUserError("That sub-account wasn't found in this agency.");
  const state = await inviteState(subAccountId, email);
  const kept = await keptTerritories(subAccountId, state, role);
  const emails = state.kind !== "member" && state.kind !== "blocked";
  const sender = emails ? await resolvePlatformSender(subAccountId) : null;
  const mail = state.kind === "new" || state.kind === "pending" ? "the invite email with the signup link" : "a notification that they were added";
  return {
    rows: [
      { label: "Sub-account", value: oneLine(sub.data()?.name ?? sub.id) },
      { label: "Email", value: email },
      { label: "Role", value: ROLE[role] },
      { label: "What happens", value: happens(state, role) },
      ...territoriesRow(state, role, kept),
      {
        label: "Email sent",
        value: state.kind === "blocked"
          ? "None."
          : !emails
            ? "None (already a member)."
            : sender
              ? `Yes: ${mail}.`
              : "No: email isn't configured on this deployment. Copy the invite link from Settings → Members and share it yourself.",
      },
    ],
    pinned: { email, role, state, territories: kept.ids },
  };
}
