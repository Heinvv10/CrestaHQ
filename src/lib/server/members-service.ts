import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import type { UserRecord } from "firebase-admin/auth";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail } from "@/lib/comms/resend";
import { isEmailSuppressedError } from "@/lib/comms/email-suppression";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { resolveBrandName } from "@/lib/landing/resolve-brand";

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
  const { subAccountId, invitedByUid, email, role } = input;

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

  if (existingUser) {
    return addExistingUserAsMember({
      db,
      existingUser,
      agencyId,
      subAccountId,
      subAccountName,
      role,
      assignedTerritoryIds,
      invitedByUid,
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
    });
    inviteId = ref.id;
  }

  const inviteUrl = buildInviteUrl(email);

  // Send the delivery email. Failures here don't roll back the invite — the
  // admin can still copy the link from the UI and share it manually.
  let mailed = false;
  let mailSuppressed = false;
  let mailError: string | null = null;
  if (emailIsConfigured()) {
    try {
      const inviterSnap = await db.doc(`users/${invitedByUid}`).get();
      const inviterData = inviterSnap.data() ?? {};
      const inviterName =
        (inviterData.displayName as string) ||
        (inviterData.email as string) ||
        "A teammate";
      const roleLabel = role === "admin" ? "Admin" : "Collaborator";
      const brandName = await resolveBrandName();

      await sendEmail({
        suppressionSubAccountId: subAccountId,
        to: email,
        // "Who is this?" replies go to the person who sent the invite.
        replyTo: (inviterData.email as string) || undefined,
        subject: `${inviterName} invited you to ${subAccountName} on ${brandName}`,
        text: renderInviteText({
          inviterName,
          subAccountName,
          roleLabel,
          inviteUrl,
          brandName,
        }),
        html: renderInviteHtml({
          inviterName,
          subAccountName,
          roleLabel,
          inviteUrl,
          brandName,
        }),
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
  if (!alreadyMember && recipient && emailIsConfigured()) {
    try {
      const inviterName = await resolveInviterName(db, invitedByUid);
      const inviterEmail =
        ((await db.doc(`users/${invitedByUid}`).get()).data()?.email as
          | string
          | undefined) || undefined;
      const roleLabel = role === "admin" ? "Admin" : "Collaborator";
      const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
      const brandName = await resolveBrandName();
      await sendEmail({
        suppressionSubAccountId: subAccountId,
        to: recipient,
        // "Who added me?" replies go to the admin who did.
        replyTo: inviterEmail,
        subject: `You've been added to ${subAccountName} on ${brandName}`,
        text: renderAddedText({
          inviterName,
          subAccountName,
          roleLabel,
          appUrl,
          brandName,
        }),
        html: renderAddedHtml({
          inviterName,
          subAccountName,
          roleLabel,
          appUrl,
          brandName,
        }),
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

function buildInviteUrl(email: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const path = `/signup?email=${encodeURIComponent(email)}`;
  return appUrl ? `${appUrl}${path}` : path;
}

interface InviteContext {
  inviterName: string;
  subAccountName: string;
  roleLabel: string;
  inviteUrl: string;
  brandName: string;
}

function renderInviteText({
  inviterName,
  subAccountName,
  roleLabel,
  inviteUrl,
  brandName,
}: InviteContext): string {
  return [
    `${inviterName} invited you to join ${subAccountName} on ${brandName} as ${roleLabel}.`,
    "",
    `Accept the invite by creating your account here:`,
    inviteUrl,
    "",
    `If you weren't expecting this invite, you can safely ignore this email.`,
  ].join("\n");
}

function renderInviteHtml({
  inviterName,
  subAccountName,
  roleLabel,
  inviteUrl,
  brandName,
}: InviteContext): string {
  const inviter = escapeHtml(inviterName);
  const sub = escapeHtml(subAccountName);
  const role = escapeHtml(roleLabel);
  const url = escapeHtml(inviteUrl);
  const brand = escapeHtml(brandName);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>You're invited to ${sub} on ${brand}</title>
</head>
<body style="margin:0; padding:0; background:#f6f6f9; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color:#0a0a0f;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f9; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px; background:#ffffff; border-radius:16px; padding:32px; box-shadow:0 1px 3px rgba(0,0,0,0.04);">
          <tr>
            <td style="padding-bottom:20px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle; padding-right:8px;">
                    <svg width="22" height="22" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
                      <defs>
                        <linearGradient id="ls-mail-1" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#7c3aed"/></linearGradient>
                        <linearGradient id="ls-mail-2" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#a855f7"/></linearGradient>
                        <linearGradient id="ls-mail-3" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#c026d3"/><stop offset="100%" stop-color="#ec4899"/></linearGradient>
                      </defs>
                      <path d="M 56 8 L 18 8 L 8 16 L 18 24 L 56 24 Z" fill="url(#ls-mail-1)"/>
                      <path d="M 8 28 L 46 28 L 56 36 L 46 44 L 8 44 Z" fill="url(#ls-mail-2)"/>
                      <path d="M 56 48 L 18 48 L 8 56 L 18 60 L 56 60 Z" fill="url(#ls-mail-3)"/>
                    </svg>
                  </td>
                  <td style="vertical-align:middle;">
                    <span style="font-size:18px; font-weight:700; color:#0a0a0f; letter-spacing:-0.01em;">${brand}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td>
              <h1 style="margin:0 0 12px 0; font-size:22px; font-weight:600; color:#0a0a0f; letter-spacing:-0.01em;">You're invited</h1>
              <p style="margin:0 0 8px 0; font-size:15px; line-height:1.5; color:#4a4a55;">${inviter} invited you to <strong style="color:#0a0a0f;">${sub}</strong> on ${brand}.</p>
              <p style="margin:0 0 24px 0; font-size:15px; line-height:1.5; color:#4a4a55;">You'll join as <strong>${role}</strong>.</p>
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <a href="${url}" style="display:inline-block; background:#7c3aed; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-size:14px; font-weight:600;">Accept invite</a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0 0; font-size:13px; line-height:1.5; color:#8a8a95;">Or paste this link into your browser:<br/><a href="${url}" style="color:#7c3aed; word-break:break-all;">${url}</a></p>
              <p style="margin:24px 0 0 0; font-size:12px; line-height:1.5; color:#8a8a95;">If you weren't expecting this invite, you can safely ignore this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface AddedContext {
  inviterName: string;
  subAccountName: string;
  roleLabel: string;
  /** Deployment URL for the "Open" button. May be "". */
  appUrl: string;
  brandName: string;
}

function renderAddedText({
  inviterName,
  subAccountName,
  roleLabel,
  appUrl,
  brandName,
}: AddedContext): string {
  return [
    `${inviterName} added you to ${subAccountName} on ${brandName} as ${roleLabel}.`,
    "",
    `You already have an account, so there's nothing to accept — just sign in and ${subAccountName} will be in your workspace switcher.`,
    ...(appUrl ? ["", `Open ${brandName}:`, appUrl] : []),
  ].join("\n");
}

function renderAddedHtml({
  inviterName,
  subAccountName,
  roleLabel,
  appUrl,
  brandName,
}: AddedContext): string {
  const inviter = escapeHtml(inviterName);
  const sub = escapeHtml(subAccountName);
  const role = escapeHtml(roleLabel);
  const url = escapeHtml(appUrl);
  const brand = escapeHtml(brandName);
  const cta = appUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <a href="${url}" style="display:inline-block; background:#7c3aed; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-size:14px; font-weight:600;">Open ${brand}</a>
                  </td>
                </tr>
              </table>`
    : "";
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>You've been added to ${sub} on ${brand}</title>
</head>
<body style="margin:0; padding:0; background:#f6f6f9; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color:#0a0a0f;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f9; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px; background:#ffffff; border-radius:16px; padding:32px; box-shadow:0 1px 3px rgba(0,0,0,0.04);">
          <tr>
            <td style="padding-bottom:20px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle; padding-right:8px;">
                    <svg width="22" height="22" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
                      <defs>
                        <linearGradient id="ls-mail-1" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#7c3aed"/></linearGradient>
                        <linearGradient id="ls-mail-2" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#a855f7"/></linearGradient>
                        <linearGradient id="ls-mail-3" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#c026d3"/><stop offset="100%" stop-color="#ec4899"/></linearGradient>
                      </defs>
                      <path d="M 56 8 L 18 8 L 8 16 L 18 24 L 56 24 Z" fill="url(#ls-mail-1)"/>
                      <path d="M 8 28 L 46 28 L 56 36 L 46 44 L 8 44 Z" fill="url(#ls-mail-2)"/>
                      <path d="M 56 48 L 18 48 L 8 56 L 18 60 L 56 60 Z" fill="url(#ls-mail-3)"/>
                    </svg>
                  </td>
                  <td style="vertical-align:middle;">
                    <span style="font-size:18px; font-weight:700; color:#0a0a0f; letter-spacing:-0.01em;">${brand}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td>
              <h1 style="margin:0 0 12px 0; font-size:22px; font-weight:600; color:#0a0a0f; letter-spacing:-0.01em;">You've been added</h1>
              <p style="margin:0 0 8px 0; font-size:15px; line-height:1.5; color:#4a4a55;">${inviter} added you to <strong style="color:#0a0a0f;">${sub}</strong> on ${brand} as <strong>${role}</strong>.</p>
              <p style="margin:0 0 24px 0; font-size:15px; line-height:1.5; color:#4a4a55;">You already have an account, so there's nothing to accept — just sign in and ${sub} will be in your workspace switcher.</p>
              ${cta}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
