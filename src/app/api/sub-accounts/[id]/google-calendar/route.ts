import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { isLoopbackOrUnparseableUrl } from "@/lib/gbp/provider/loopback.mjs";
import { gcalConnectionPath, readConnection } from "@/lib/google-calendar/connection";
import { googleCalendarGateOn } from "@/lib/google-calendar/gate";
import { gcalAppConfigured, gcalFakeAllowed } from "@/lib/google-calendar/provider/mode";
import {
  assertGcalFakeFixtureAgency,
  getGcalProviderFor,
} from "@/lib/google-calendar/provider/select";
import type { GcalProvider } from "@/lib/google-calendar/provider/types";

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
 *     is switched off. Revokes at Google best-effort, then deletes the doc.
 *     Events already written to Google stay there.
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

  // Before any read or write, the fake's fixture-agency fence (same shape as
  // the GBP disconnect): an allowed fake throws in getGcalProviderFor for a
  // sub-account outside the fixture agency; a requested-but-refused fake on
  // a dev machine (loopback URL, production Firestore) is fenced here too.
  let provider: GcalProvider | null = null;
  if (process.env.GCAL_PROVIDER === "fake" && !gcalFakeAllowed()) {
    if (isLoopbackOrUnparseableUrl(process.env.NEXT_PUBLIC_APP_URL)) {
      await assertGcalFakeFixtureAgency(id);
    }
    console.warn(`[google-calendar/disconnect] fake provider refused here; skipping revoke sa=${id}`);
  } else {
    provider = await getGcalProviderFor(id, access.uid);
  }

  const conn = await readConnection(id, access.uid);
  // Best-effort — a failed revoke must never leave the member stuck with a
  // connection they cannot remove.
  if (provider && conn?.refreshToken) {
    try {
      await provider.revoke(conn.refreshToken);
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : typeof err;
      console.warn(`[google-calendar/disconnect] revoke failed sa=${id}`, reason);
    }
  }
  await getAdminDb().doc(gcalConnectionPath(id, access.uid)).delete();
  return NextResponse.json({ ok: true });
}
