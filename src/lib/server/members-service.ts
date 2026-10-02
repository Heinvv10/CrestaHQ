import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import type { UserRecord } from "firebase-admin/auth";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import {
  noPlatformSender,
  resolvePlatformSender,
  sendPlatformEmail,
} from "@/lib/comms/platform-email";
import { isEmailSuppressedError } from "@/lib/comms/email-suppression";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { recordSubAccountAuditEvent } from "@/lib/audit/record";
import type { AuditActor } from "@/lib/audit/types";
import { resolveCustomBrand } from "@/lib/landing/resolve-brand";
import { renderSystemEmail, type SystemEmailBrand } from "@/lib/comms/system-email";
import { generateInviteToken } from "@/lib/server/invite-token";

/**
 * Server-side member invites — the single write path shared by the invite
 * route (`POST /api/sub-accounts/[id]/invite`) and the AI Suite
 * `invite_member` capability. Extracted so both call one implementation and
 * can't drift (dedupe, delivery email, webhook event all stay in lockstep).
 *
 * Auth + input validation stay with the caller — this function trusts its
 * inputs (email already validated + lowercased, role already narrowed) and
 * just does the write.
 */

/**
 * Thrown when an already-registered account can't be silently added to a
 * workspace — it was removed/disabled (can't sign in until reactivated) or
 * belongs to a different agency. The common case (an active user in this
 * agency) is NOT an error: they're added as a member directly. See
 * {@link createInviteServerSide}.
 */
export class MemberAddBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberAddBlockedError";
  }
}

/** Thrown when the target sub-account doesn't exist. */
export class InviteSubAccountNotFoundError extends Error {
  constructor() {
    super("Sub-account not found");
    this.name = "InviteSubAccountNotFoundError";
  }
}

export interface CreateInviteInput {
  subAccountId: string;
  /** The admin/owner performing the invite. */
  invitedByUid: string;
  /**
   * Who the audit trail names for a role change: the user themselves, or the
   * Workspace Assistant acting for `invitedByUid`.
   */
  auditActor: AuditActor;
  /** Already validated + lowercased by the caller. */
  email: string;
  role: "admin" | "collaborator";
  /** Raw territory ids — validated against the sub-account in here. */
  assignedTerritoryIds?: unknown;
}

export interface CreateInviteResult {
  inviteId: string;
  email: string;
  subAccountId: string;
  subAccountName: string;
  role: "admin" | "collaborator";
  /** True when a pending invite already existed and was reused/updated. */
  reused: boolean;
  mailed: boolean;
  /** Not emailed because the address is on the sub-account's suppression list. */
  mailSuppressed: boolean;
  mailError: string | null;
  inviteUrl: string;
  /**
   * True when the email already had an account and was added to the workspace
   * DIRECTLY (no pending invite, no signup step). False for the classic
   * "new person — invite stays pending until they sign up" path.
   */
  added: boolean;
  /** True when the invitee already had an account (mirrors `added` today). */
  existing: boolean;
  /**
   * True when the added user was already an active member of this sub-account
   * (their role / territories were updated in place; no email sent).
   */
  alreadyMember: boolean;
}

export async function createInviteServerSide(
  input: CreateInviteInput,
): Promise<CreateInviteResult> {
  const { subAccountId, invitedByUid, auditActor, email, role } = input;

  const auth = getAdminAuth();
  const db = getAdminDb();

  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) throw new InviteSubAccountNotFoundError();
  const sub = subSnap.data() ?? {};
  const agencyId = (sub.agencyId as string) ?? "";
  const subAccountName = (sub.name as string) || "their workspace";

  // Pre-assign territories: only meaningful for collaborators (admins see
  // every territory regardless). Validate each id against this sub-account's
  // territories subcollection and drop anything missing/archived so a stale
  // id can't slip onto the membership. Cap at 30 to match the Firestore `in`
  // limit the rep's queries use.
  const assignedTerritoryIds =
    role === "collaborator"
      ? await validateTerritoryIds(db, subAccountId, input.assignedTerritoryIds)
      : [];

  // Two paths, decided by whether the email already has an account:
  //   - EXISTING account → add them to this workspace DIRECTLY (no signup,
  //     nothing to accept) and notify them by email. This is how someone
  //     already in one sub-account gets added to another.
  //   - NEW email → fall through to the pending-invite flow below; the invite
  //     stays pending until they sign up with that address.
  let existingUser: UserRecord | null = null;
  try {
    existingUser = await auth.getUserByEmail(email);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "auth/user-not-found") throw err;
  }

  // Direct-add only a VERIFIED account (or one already active here, where
  // re-inviting just updates the role). Anyone can create an unverified
  // Firebase user with any address, so an unverified match falls through to
  // the token invite below; signup then resolves it (see /api/auth/signup).
  const directAdd =
    existingUser !== null &&
    (existingUser.emailVerified ||
      (
        await db
          .doc(`subAccounts/${subAccountId}/subAccountMembers/${existingUser.uid}`)
          .get()
      ).data()?.status === "active");

  if (existingUser && directAdd) {
    return addExistingUserAsMember({
      db,
      existingUser,
      agencyId,
      subAccountId,
      subAccountName,
      role,
      assignedTerritoryIds,
      invitedByUid,
      auditActor,
    });
  }

  // De-dupe: any pending invite for this (email, subAccountId) wins.
  const dupSnap = await db
    .collection("invites")
    .where("email", "==", email)
    .where("subAccountId", "==", subAccountId)
    .where("acceptedByUid", "==", null)
    .where("revokedAt", "==", null)
    .limit(1)
    .get();

  // Every (re-)issue mints a fresh single-use token; only its hash is
  // stored, so a resend rotates it and earlier links stop working.
  const { token, tokenHash } = generateInviteToken();

  let inviteId: string;
  let reused = false;
  if (!dupSnap.empty) {
    inviteId = dupSnap.docs[0].id;
    reused = true;
    // Re-inviting doubles as "update": reflect the role + territories the
    // admin just picked so a corrected selection takes effect on accept.
    await dupSnap.docs[0].ref.update({
      subAccountRole: role,
      assignedTerritoryIds,
      tokenHash,
    });
  } else {
    const ref = await db.collection("invites").add({
      email,
      agencyId: sub.agencyId,
      subAccountId,
      subAccountRole: role,
      agencyRole: null,
      invitedByUid,
      createdAt: FieldValue.serverTimestamp(),
      acceptedByUid: null,
      acceptedAt: null,
      revokedAt: null,
      assignedTerritoryIds,
      tokenHash,
    });
    inviteId = ref.id;
  }

  const inviteUrl = buildInviteUrl(email, token);

  // Send the delivery email. Failures here don't roll back the invite — the
  // admin can still copy the link from the UI and share it manually.
  let mailed = false;
  let mailSuppressed = false;
  let mailError: string | null = null;
  try {
    const sender = await resolvePlatformSender(subAccountId);
    if (!sender) throw noPlatformSender("[invite]", subAccountId);
    const inviterSnap = await db.doc(`users/${invitedByUid}`).get();
    const inviterData = inviterSnap.data() ?? {};
    const inviterName =
      (inviterData.displayName as string) ||
      (inviterData.email as string) ||
      "A teammate";
    const roleLabel = role === "admin" ? "Admin" : "Collaborator";
    const brand = await resolveCustomBrand();

    await sendPlatformEmail(sender, {
      suppressionSubAccountId: subAccountId,
      to: email,
      // "Who is this?" replies go to the person who sent the invite.
      replyTo: (inviterData.email as string) || undefined,
      subject: `${inviterName} invited you to ${subAccountName} on ${brand.name}`,
      ...inviteEmail({ inviterName, subAccountName, roleLabel, inviteUrl, brand }),
    });
    mailed = true;
  } catch (err) {
    mailSuppressed = isEmailSuppressedError(err);
    mailError = err instanceof Error ? err.message : String(err);
    console.warn(
      "[invite] sendEmail failed — invite still created",
      mailError,
    );
  }

  // Public-API webhook event so subscribers (e.g. an HR / onboarding
  // Zapier flow) see new teammate invites in real time. Fire-and-forget;
  // dispatch failures don't unwind the invite. We emit on every call
  // including resends — `reused: true` lets subscribers distinguish.
  void emitWebhookEvent({
    subAccountId,
    agencyId: (sub.agencyId as string) ?? "",
    mode: "live",
    type: "member.invited",
    payload: {
      invite: {
        id: inviteId,
        object: "invite",
        email,
        role,
        invited_by_uid: invitedByUid,
        assigned_territory_ids: assignedTerritoryIds,
        reused,
        mailed,
        created_at: new Date().toISOString(),
      },
    },
  });

  return {
    inviteId,
    email,
    subAccountId,
    subAccountName,
    role,
    reused,
    mailed,
    mailSuppressed,
    mailError,
    inviteUrl,
    added: false,
    existing: false,
    alreadyMember: false,
  };
}

/**
 * Add an already-registered user to a sub-account directly — no invite doc,
 * no signup step. Per-sub-account access is decided by this membership row
 * (rules read it via get()), and the user's JWT claims are agency-level
 * scalars that don't change, so access is live on their next load with no
 * re-login. Idempotent: re-adding an active member just updates their role /
 * territories in place. Notifies the user by email unless they were already
 * an active member.
 */
async function addExistingUserAsMember(params: {
  db: FirebaseFirestore.Firestore;
  existingUser: UserRecord;
  agencyId: string;
  subAccountId: string;
  subAccountName: string;
  role: "admin" | "collaborator";
  assignedTerritoryIds: string[];
  invitedByUid: string;
  auditActor: AuditActor;
}): Promise<CreateInviteResult> {
  const {
    db,
    existingUser,
    agencyId,
    subAccountId,
    subAccountName,
    role,
    assignedTerritoryIds,
    invitedByUid,
    auditActor,
  } = params;
  const uid = existingUser.uid;
  const claims = (existingUser.customClaims ?? {}) as {
    agencyId?: string;
    status?: string;
  };

  // Can't silently re-add a removed/disabled account — they can't sign in
  // until it's reactivated, so a membership row alone would be a dead entry.
  if (existingUser.disabled || claims.status === "removed") {
    throw new MemberAddBlockedError(
      "This person's account was removed or disabled. Reactivate it before adding them to a workspace.",
    );
  }
  // Never add someone from a different agency. One agency per deployment in
  // v1, so this only matters for a future multi-agency setup — but it keeps
  // the guard honest.
  if (claims.agencyId && claims.agencyId !== agencyId) {
    throw new MemberAddBlockedError(
      "This email belongs to a different agency and can't be added to this workspace.",
    );
  }

  const memberRef = db.doc(
    `subAccounts/${subAccountId}/subAccountMembers/${uid}`,
  );
  const userDocRef = db.doc(`users/${uid}`);
  const [memberSnap, userDocSnap] = await Promise.all([
    memberRef.get(),
    userDocRef.get(),
  ]);
  const alreadyMember =
    memberSnap.exists && memberSnap.data()?.status === "active";

  const batch = db.batch();

  // A normally-signed-up user already has a slim users/{uid} profile doc.
  // Backfill a minimal one when it's missing (an account created outside the
  // signup flow) so directly-added members are first-class and downstream
  // reads — the profile header, the member-removal cleanup — never hit a
  // missing doc. Only creates when absent; never clobbers an existing profile.
  if (!userDocSnap.exists) {
    batch.set(userDocRef, {
      uid,
      email: existingUser.email ?? "",
      displayName: existingUser.displayName ?? "",
      photoURL: existingUser.photoURL ?? null,
      status: "active",
      primaryAgencyId: agencyId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  if (memberSnap.exists) {
    // Reactivate / update in place — preserve the original addedAt.
    batch.set(
      memberRef,
      {
        role,
        status: "active",
        email: existingUser.email ?? "",
        displayName: existingUser.displayName ?? "",
        assignedTerritoryIds,
      },
      { merge: true },
    );
  } else {
    batch.set(memberRef, {
      uid,
      subAccountId,
      agencyId,
      role,
      status: "active",
      email: existingUser.email ?? "",
      displayName: existingUser.displayName ?? "",
      addedAt: FieldValue.serverTimestamp(),
      addedByUid: invitedByUid,
      assignedTerritoryIds,
    });
  }
  // (Re)write the denormalized switcher index so the workspace shows up for
  // them live via the userMemberships onSnapshot.
  batch.set(db.doc(`userMemberships/${uid}/subAccounts/${subAccountId}`), {
    subAccountId,
    agencyId,
    role,
    name: subAccountName,
    addedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  // Re-adding an existing member (active or removed) overwrites their role.
  const previousRole = memberSnap.data()?.role as string | undefined;
  if (memberSnap.exists && previousRole !== role) {
    await recordSubAccountAuditEvent(db, subAccountId, {
      action: "member.role_changed",
      actor: auditActor,
      ...(auditActor.type === "user" ? {} : { onBehalfOfUid: invitedByUid }),
      target: { type: "member", id: uid },
      changes: [{ field: "role", before: previousRole, after: role }],
    });
  }

  // Public-API webhook event — the direct-add counterpart to `member.invited`
  // (which only covers brand-new invitees). `already_member` lets subscribers
  // distinguish a fresh add from a role update on an existing member.
  // Fire-and-forget; dispatch failures don't unwind the membership.
  void emitWebhookEvent({
    subAccountId,
    agencyId,
    mode: "live",
    type: "member.added",
    payload: {
      member: {
        uid,
        object: "member",
        email: existingUser.email ?? "",
        role,
        added_by_uid: invitedByUid,
        assigned_territory_ids: assignedTerritoryIds,
        already_member: alreadyMember,
        added_at: new Date().toISOString(),
      },
    },
  });

  // Notify the user they now have access. No accept link — they already have
  // an account and access is live. Skipped when they were already a member.
  let mailed = false;
  let mailSuppressed = false;
  let mailError: string | null = null;
  const recipient = existingUser.email ?? "";
  if (!alreadyMember && recipient) {
    try {
      const sender = await resolvePlatformSender(subAccountId);
      if (!sender) throw noPlatformSender("[invite]", subAccountId);
      const inviterName = await resolveInviterName(db, invitedByUid);
      const inviterEmail =
        ((await db.doc(`users/${invitedByUid}`).get()).data()?.email as
          | string
          | undefined) || undefined;
      const roleLabel = role === "admin" ? "Admin" : "Collaborator";
      const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
      const brand = await resolveCustomBrand();
      await sendPlatformEmail(sender, {
        suppressionSubAccountId: subAccountId,
        to: recipient,
        // "Who added me?" replies go to the admin who did.
        replyTo: inviterEmail,
        subject: `You've been added to ${subAccountName} on ${brand.name}`,
        ...addedEmail({ inviterName, subAccountName, roleLabel, appUrl, brand }),
      });
      mailed = true;
    } catch (err) {
      mailSuppressed = isEmailSuppressedError(err);
      mailError = err instanceof Error ? err.message : String(err);
      console.warn(
        "[invite] added-member email failed — membership still written",
        mailError,
      );
    }
  }

  return {
    inviteId: "",
    email: recipient,
    subAccountId,
    subAccountName,
    role,
    reused: false,
    mailed,
    mailSuppressed,
    mailError,
    inviteUrl: "",
    added: true,
    existing: true,
    alreadyMember,
  };
}

async function resolveInviterName(
  db: FirebaseFirestore.Firestore,
  invitedByUid: string,
): Promise<string> {
  const snap = await db.doc(`users/${invitedByUid}`).get();
  const data = snap.data() ?? {};
  return (data.displayName as string) || (data.email as string) || "A teammate";
}

/**
 * Keep only the ids that resolve to an active territory in this
 * sub-account. Deduped + capped at 30 (the Firestore `in` limit the
 * collaborator's deal/contact queries rely on). Returns [] for any
 * non-array input.
 */
async function validateTerritoryIds(
  db: FirebaseFirestore.Firestore,
  subAccountId: string,
  raw: unknown,
): Promise<string[]> {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const wanted = [
    ...new Set(raw.filter((x): x is string => typeof x === "string" && !!x)),
  ].slice(0, 30);
  if (wanted.length === 0) return [];

  const refs = wanted.map((tid) =>
    db.doc(`subAccounts/${subAccountId}/territories/${tid}`),
  );
  const snaps = await db.getAll(...refs);
  return snaps
    .filter((s) => s.exists && s.data()?.status === "active")
    .map((s) => s.id);
}

function buildInviteUrl(email: string, token: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const path = `/signup?email=${encodeURIComponent(email)}&invite=${encodeURIComponent(token)}`;
  return appUrl ? `${appUrl}${path}` : path;
}

interface InviteContext {
  inviterName: string;
  subAccountName: string;
  roleLabel: string;
  inviteUrl: string;
  brand: SystemEmailBrand;
}

function inviteEmail({
  inviterName,
  subAccountName,
  roleLabel,
  inviteUrl,
  brand,
}: InviteContext): { text: string; html: string } {
  return renderSystemEmail({
    brand,
    preview: `${inviterName} invited you to ${subAccountName}.`,
    heading: "You're invited",
    paragraphs: [
      `${inviterName} invited you to **${subAccountName}** on ${brand.name}.`,
      `You'll join as **${roleLabel}**.`,
    ],
    button: { label: "Accept invite", url: inviteUrl },
    note: "If you weren't expecting this invite, you can safely ignore this email.",
  });
}

interface AddedContext {
  inviterName: string;
  subAccountName: string;
  roleLabel: string;
  /** Deployment URL for the "Open" button. May be "". */
  appUrl: string;
  brand: SystemEmailBrand;
}

function addedEmail({
  inviterName,
  subAccountName,
  roleLabel,
  appUrl,
  brand,
}: AddedContext): { text: string; html: string } {
  return renderSystemEmail({
    brand,
    preview: `You now have access to ${subAccountName}.`,
    heading: "You've been added",
    paragraphs: [
      `${inviterName} added you to **${subAccountName}** on ${brand.name} as **${roleLabel}**.`,
      `You already have an account, so there's nothing to accept — just sign in and ${subAccountName} will be in your workspace switcher.`,
    ],
    ...(appUrl ? { button: { label: `Open ${brand.name}`, url: appUrl } } : {}),
  });
}
