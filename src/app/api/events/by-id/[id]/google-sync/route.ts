import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGate } from "@/lib/auth/territory-filter";
import { pushBookingToGoogle } from "@/lib/google-calendar/push";

/**
 * Retry a booking's Google Calendar sync (the event dialog's "Retry sync").
 *
 *   POST /api/events/by-id/[id]/google-sync → { ok, synced, googleSyncError }
 *
 * `synced` is true only when the event, read after the push, carries no sync
 * error: the dialog may then clear its notice without waiting for the
 * Listen delta.
 *
 * Any active member of the event's sub-account. Runs the same push as every
 * booking path, with the same host checks (active members who are page hosts
 * or on the event's server-set hostUids) — a retry can reach no calendar a
 * normal push could not. One retry per event per 30 s (429 otherwise).
 */
const RETRY_COOLDOWN_MS = 30_000;

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ref = getAdminDb().collection("events").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  const access = await requireSubAccountMember(request, snap.data()?.subAccountId as string);
  if (access instanceof NextResponse) return access;
  const gate = await territoryGate(access, snap.data()?.territoryId as string | null | undefined);
  if (gate) return gate;

  // One retry per event per 30 s: each is a round of Google calls per host.
  // Read and stamp in one transaction so two concurrent clicks can't both pass.
  const allowed = await getAdminDb().runTransaction(async (txn) => {
    const cur = await txn.get(ref);
    const last = (cur.data()?.googleSyncRetryAt as { toMillis?: () => number } | Date | undefined) ?? null;
    const lastMs = last instanceof Date ? last.getTime() : (last?.toMillis?.() ?? 0);
    if (Date.now() - lastMs < RETRY_COOLDOWN_MS) return false;
    txn.update(ref, { googleSyncRetryAt: new Date() });
    return true;
  });
  if (!allowed) {
    return NextResponse.json({ error: "Retried moments ago — wait 30 seconds." }, { status: 429 });
  }

  await pushBookingToGoogle(id);
  const after = (await ref.get()).data();
  return NextResponse.json({
    ok: true,
    synced: !!after && !after.googleSyncError,
    googleSyncError: after?.googleSyncError?.message ?? null,
  });
}
