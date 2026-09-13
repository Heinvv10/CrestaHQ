import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { gcalConnectionPath, readConnection } from "@/lib/google-calendar/connection";
import { googleCalendarGateOn } from "@/lib/google-calendar/gate";
import { gcalAppConfigured } from "@/lib/google-calendar/provider/mode";

/**
 * The CALLER's own Google Calendar connection on this sub-account.
 *
 *   GET    /api/sub-accounts/[id]/google-calendar
 *     → { configured, connected, status, googleEmail, lastError, lastPushError }
 *     Any active member. While the agency gate is off: { gateOff: true,
 *     connected, googleEmail } only — enough for the card to offer Disconnect
 *     on a connection left behind. Never a token, never another member's.
 *
 *   DELETE /api/sub-accounts/[id]/google-calendar
 *     UNGATED, so a member can always remove their connection after the gate
 *     is switched off. Deletes the stored tokens only — never revokes at
 *     Google (see below). Events already written to Google stay there.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;
  const conn = await readConnection(id, access.uid);
  if (!(await googleCalendarGateOn(id))) {
    return NextResponse.json({
      gateOff: true,
      connected: !!conn,
      googleEmail: conn?.googleEmail ?? null,
    });
  }
  return NextResponse.json({
    configured: gcalAppConfigured(),
    connected: conn?.status === "connected",
    status: conn?.status ?? null,
    googleEmail: conn?.googleEmail ?? null,
    lastError: conn?.lastError ?? null,
    lastPushError: conn?.lastPushError ?? null,
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;
  // Deliberately NO revoke at Google: this is the same OAuth client as the
  // Business Profile connection, and revoking a token ends the app's whole
  // grant for that Google account — it could take the sub-account's GBP
  // connection down with it. The card tells the member where to remove the
  // app's access themselves (myaccount.google.com/permissions).
  await getAdminDb().doc(gcalConnectionPath(id, access.uid)).delete();
  return NextResponse.json({ ok: true });
}
