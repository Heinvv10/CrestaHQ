import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { GitpageError, pollBuild } from "@/lib/gitpage/client";
import { markGitpageKeyInvalid } from "@/lib/gitpage/heartbeat";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import type { WebsiteDoc } from "@/types/website";

export const dynamic = "force-dynamic";

/**
 * Manual poll trigger for one website — admin-gated, runs one immediate poll
 * against gitpage's status endpoint without going through QStash. Use cases:
 * the QStash chain has stalled (NEXT_PUBLIC_APP_URL mismatch, region drift,
 * signing-key issues) and the build is stuck queued/building far past
 * the 15-min cap, OR the doc settled as "failed" via the poll-cap timeout
 * while gitpage kept building (long builds run 10–14 min and can exceed the
 * cap) — re-checking resurrects it to ready without a rebuild.
 *
 * Mirrors the body of /poll's QStash-callback handler:
 *   - Settle terminal states (ready / failed)
 *   - On 401 → markGitpageKeyInvalid()
 *   - On 4xx → settle as failed
 *   - On still-in-flight → reset pollAttempts and republish a fresh
 *     QStash chain so future polls work too
 *
 * Returns the resolved/intermediate state so the caller can update the UI
 * without waiting for Firestore to fan-out.
 */

const POLL_INTERVAL_SECONDS = 20;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const docRef = db.doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await docRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "No website doc." }, { status: 404 });
  }
  const websiteDoc = snap.data() as WebsiteDoc;

  // Queued/building = the normal stalled-chain nudge. A doc that settled as
  // "failed" but still carries a gitpage job id is ALSO re-checkable: the
  // 15-min poll cap settles on our side while gitpage may still finish, so
  // a manual re-check can resurrect it straight to ready without burning a
  // rebuild against gitpage's hourly cap.
  const recheckable =
    websiteDoc.status === "queued" ||
    websiteDoc.status === "building" ||
    (websiteDoc.status === "failed" && !!websiteDoc.gitpageJobId);
  if (!recheckable) {
    return NextResponse.json({
      ok: true,
      ignored: "not-in-flight",
      status: websiteDoc.status,
    });
  }

  const formResponseId = websiteDoc.gitpageJobId;
  if (!formResponseId) {
    return NextResponse.json(
      { error: "No gitpage job id on doc." },
      { status: 400 },
    );
  }

  let pollResult;
  try {
    pollResult = await pollBuild(formResponseId);
  } catch (err) {
    if (err instanceof GitpageError && err.status === 401) {
      await markGitpageKeyInvalid();
    }
    if (err instanceof GitpageError && err.status >= 400 && err.status < 500) {
      await docRef.update({
        status: "failed",
        errorMessage: `gitpage rejected the poll: ${err.message}`,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return NextResponse.json({ ok: true, settled: "client-error" });
    }
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Poll request failed.",
      },
      { status: 502 },
    );
  }

  if (pollResult.isTerminal) {
    if (pollResult.status === "Published") {
      await docRef.update({
        status: "ready",
        liveUrl: pollResult.pagesUrl,
        errorMessage: null,
        partialErrors: pollResult.partialErrors,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return NextResponse.json({
        ok: true,
        settled: "ready",
        liveUrl: pollResult.pagesUrl,
      });
    }
    await docRef.update({
      status: "failed",
      errorMessage: pollResult.error ?? "gitpage build failed without details.",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({
      ok: true,
      settled: "failed",
      errorMessage: pollResult.error,
    });
  }

  // Still in flight. Reset pollAttempts so the user gets a fresh 15-min
  // window after this manual nudge, and restart the QStash chain so the
  // next tick fires automatically (recovers from a stalled chain). A doc
  // that had settled as "failed" (poll-cap timeout) flips back to
  // "building" — gitpage says the job is still running — and its stale
  // error message is cleared.
  const nextStatus =
    pollResult.statusPhase && pollResult.statusPhase !== "processing"
      ? "building"
      : websiteDoc.status === "failed"
        ? "building"
        : websiteDoc.status;

  await docRef.update({
    status: nextStatus,
    errorMessage: null,
    pollAttempts: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });

  let rescheduled = false;
  if (qstashIsConfigured()) {
    const result = await publishCallback({
      pathname: `/api/sub-accounts/${subAccountId}/website/${siteId}/poll`,
      body: { subAccountId, siteId, formResponseId },
      delaySeconds: POLL_INTERVAL_SECONDS,
      // Manual trigger gets its own dedup namespace + timestamp so it
      // never collides with whatever the original (possibly broken)
      // chain published.
      deduplicationId: `website_${subAccountId}_${siteId}_${formResponseId}_manual_${Date.now()}`,
    });
    rescheduled = result !== null;
  }

  return NextResponse.json({
    ok: true,
    deferred: "in-flight",
    status: nextStatus,
    statusPhase: pollResult.statusPhase,
    rescheduled,
  });
}
