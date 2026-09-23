import "server-only";

import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { endCallViaControl } from "@/lib/comms/voice/vapi";
import type { VoiceCampaignDoc, VoiceCampaignRecipientDoc } from "@/types";

export const dynamic = "force-dynamic";

type Body = { campaignId?: string; mode?: "scheduled" | "all" };

/**
 * Kill switch for a bulk calling campaign. Two modes:
 *
 *   - "scheduled" (default): flip to "cancelled" and skip every still-queued
 *     recipient. Calls already CONNECTED finish naturally (capped by
 *     maxCallSeconds).
 *   - "all": same as above, AND end every still-live call this campaign
 *     placed by POSTing end-call to each stored control URL.
 *
 * QStash messages already scheduled still fire, but the step route sees the
 * cancelled status / already-settled rows and no-ops. The status flips
 * before the sweep, and each step re-reads it in a transaction just before
 * dialling, so no call is placed after this route has flipped it.
 *
 * A call can only be ended within its max duration, so for "all" we only
 * look at recipients dialled in the last 15 minutes — that's a small set
 * (per-minute pacing) and guaranteed to cover anything still live. Ending
 * an already-finished call is harmless (Vapi 4xx, swallowed).
 */
const LIVE_LOOKBACK_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const campaignId = payload.campaignId?.trim();
  const mode = payload.mode === "all" ? "all" : "scheduled";
  if (!campaignId) {
    return NextResponse.json(
      { error: "campaignId is required" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const campaignRef = db.collection("voiceCampaigns").doc(campaignId);
  const snap = await campaignRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  const campaign = snap.data() as VoiceCampaignDoc;

  const access = await requireSubAccountMember(request, campaign.subAccountId);
  if (access instanceof NextResponse) return access;

  // Flip the campaign FIRST: from here on every step's pre-dial claim
  // (a transaction reading this status) skips instead of dialling.
  const priorStatus = await db.runTransaction(async (tx) => {
    const current = (await tx.get(campaignRef)).data() as VoiceCampaignDoc;
    if (current.status === "completed" || current.status === "cancelled") {
      return current.status;
    }
    tx.update(campaignRef, {
      status: "cancelled",
      completedAt: FieldValue.serverTimestamp(),
    });
    return null;
  });

  // End live calls (only meaningful for "all"). Even if the campaign was
  // already cancelled (scheduled-stop earlier), an operator can hit
  // "stop all" to also kill calls still ringing from that first stop.
  let endedLive = 0;
  if (mode === "all") {
    const cutoff = Timestamp.fromMillis(Date.now() - LIVE_LOOKBACK_MS);
    // Single-field range query (settledAt) — no composite index needed.
    // Queued rows have settledAt null and are excluded by the range.
    const recentSnap = await campaignRef
      .collection("recipients")
      .where("settledAt", ">=", cutoff)
      .get();
    const live = recentSnap.docs
      .map((d) => d.data() as VoiceCampaignRecipientDoc)
      .filter((r) => r.status === "called" && !!r.callControlUrl);
    const results = await Promise.allSettled(
      live.map((r) => endCallViaControl(r.callControlUrl as string)),
    );
    endedLive = results.filter((r) => r.status === "fulfilled").length;
  }

  if (priorStatus) {
    return NextResponse.json({
      ok: true,
      alreadyStopped: priorStatus,
      endedLive,
    });
  }

  // Skip every still-queued recipient. Each chunk is a transaction that
  // re-reads its rows, so a row a step claimed meanwhile is left alone and
  // nothing is counted twice.
  const queuedSnap = await campaignRef
    .collection("recipients")
    .where("status", "==", "queued")
    .get();

  let stopped = 0;
  const refs = queuedSnap.docs.map((d) => d.ref);
  for (let i = 0; i < refs.length; i += 100) {
    stopped += await db.runTransaction(async (tx) => {
      const snaps = await tx.getAll(...refs.slice(i, i + 100));
      const queued = snaps.filter(
        (s) => (s.data() as VoiceCampaignRecipientDoc | undefined)?.status === "queued",
      );
      for (const s of queued) {
        tx.update(s.ref, {
          status: "skipped",
          skippedReason: "cancelled",
          settledAt: FieldValue.serverTimestamp(),
        });
      }
      if (queued.length > 0) {
        tx.update(campaignRef, {
          "totals.skipped": FieldValue.increment(queued.length),
          "totals.queued": FieldValue.increment(-queued.length),
        });
      }
      return queued.length;
    });
  }

  return NextResponse.json({ ok: true, stopped, endedLive });
}
