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
 *     → { configured, connected, status, googleEmail, lastError, lastErrorAt }
 *     Any active member; 403 `gate_off` while the agency gate is off. Never a
 *     token, and never another member's connection.
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
  if (!(await googleCalendarGateOn(id))) {
    return NextResponse.json({ error: "gate_off" }, { status: 403 });
  }

  const conn = await readConnection(id, access.uid);
  return NextResponse.json({
    configured: gcalAppConfigured(),
    connected: conn?.status === "connected",
    status: conn?.status ?? null,
    googleEmail: conn?.googleEmail ?? null,
    lastError: conn?.lastError ?? null,
    lastErrorAt: conn?.lastErrorAt ?? null,
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
