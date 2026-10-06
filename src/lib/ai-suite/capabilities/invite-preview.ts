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
 */

export type InviteState =
  | { kind: "new" }
  | { kind: "pending"; role: string }
  | { kind: "account"; uid: string }
  | { kind: "member"; uid: string; role: string }
  | { kind: "former_member"; uid: string; role: string };

const ROLE = {
  admin: "Admin: manages members and settings",
  collaborator: "Collaborator: works the data, no member management",
} as const;

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
      throw new CapabilityUserError("This person's account was removed or disabled. Reactivate it before adding them to a workspace.");
    }
    if (claims.agencyId && claims.agencyId !== agencyId) {
      throw new CapabilityUserError("This email belongs to a different agency and can't be added to this workspace.");
    }
    if (!member) return { kind: "account", uid: user.uid };
    const role = String(member.role ?? "member");
    return member.status === "active" ? { kind: "member", uid: user.uid, role } : { kind: "former_member", uid: user.uid, role };
  }
  const pending = await db
    .collection("invites")
    .where("email", "==", email)
    .where("subAccountId", "==", subAccountId)
    .where("acceptedByUid", "==", null)
    .where("revokedAt", "==", null)
    .limit(1)
    .get();
  return pending.empty ? { kind: "new" } : { kind: "pending", role: String(pending.docs[0]!.data().subAccountRole ?? "collaborator") };
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
  }
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
  const emails = state.kind !== "member";
  const sender = emails ? await resolvePlatformSender(subAccountId) : null;
  const mail = state.kind === "new" || state.kind === "pending" ? "the invite email with the signup link" : "a notification that they were added";
  return {
    rows: [
      { label: "Sub-account", value: oneLine(sub.data()?.name ?? sub.id) },
      { label: "Email", value: email },
      { label: "Role", value: ROLE[role] },
      { label: "What happens", value: happens(state, role) },
      {
        label: "Email sent",
        value: !emails
          ? "None (already a member)."
          : sender
            ? `Yes: ${mail}.`
            : "No: email isn't configured on this deployment. Copy the invite link from Settings → Members and share it yourself.",
      },
    ],
    pinned: { email, role, state },
  };
}
