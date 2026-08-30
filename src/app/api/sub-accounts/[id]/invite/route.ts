import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  createInviteServerSide,
  MemberAddBlockedError,
  InviteSubAccountNotFoundError,
} from "@/lib/server/members-service";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Invite someone to a specific sub-account at a specific role
 * (admin | collaborator). Caller must be the agency owner OR an active
 * sub-account admin of the target sub-account.
 *
 * Two outcomes depending on the email:
 *   - NEW email → writes a typed `invites/{auto}` doc that the signup route
 *     consumes when the invitee creates their account, and (when Resend is
 *     configured) sends a delivery email with a /signup?email=<addr> link.
 *   - EXISTING account → adds them to the sub-account directly (no pending
 *     invite, nothing to accept) and emails them an "added" notification.
 *     Returns `added: true`. This is how someone already in one sub-account
 *     gets added to another.
 *
 * Idempotent on the (email, subAccountId) pair: if a pending invite already
 * exists, the doc is reused but the email is still re-sent so the admin can
 * use this endpoint as "resend" without revoking first.
 *
 * Graceful degrade: if RESEND_API_KEY isn't set, the invite doc is still
 * created and `mailed: false` is returned so the UI can prompt the admin to
 * copy the signup link manually.
 *
 * The actual write lives in `lib/server/members-service.ts` —
 * shared with the AI Suite `invite_member` capability.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: {
    email?: string;
    role?: "admin" | "collaborator";
    assignedTerritoryIds?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "Provide a valid email address." },
      { status: 400 },
    );
  }
  const role: "admin" | "collaborator" =
    body.role === "admin" ? "admin" : "collaborator";

  try {
    const res = await createInviteServerSide({
      subAccountId,
      invitedByUid: access.uid,
      email,
      role,
      assignedTerritoryIds: body.assignedTerritoryIds,
    });
    return NextResponse.json({
      ok: true,
      inviteId: res.inviteId,
      email: res.email,
      subAccountId: res.subAccountId,
      role: res.role,
      reused: res.reused,
      mailed: res.mailed,
      mailError: res.mailError,
      inviteUrl: res.inviteUrl,
      added: res.added,
      existing: res.existing,
      alreadyMember: res.alreadyMember,
    });
  } catch (err) {
    if (err instanceof MemberAddBlockedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof InviteSubAccountNotFoundError) {
      return NextResponse.json(
        { error: "Sub-account not found" },
        { status: 404 },
      );
    }
    throw err;
  }
}
