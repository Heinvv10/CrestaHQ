import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { GitpageError, pollBuild } from "@/lib/gitpage/client";
import {
  isSettleable,
  settleWebsiteBuild,
  transitionWebsite,
  WEBSITE_IN_FLIGHT,
} from "@/lib/server/websites-service";
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
 *   - On still-in-flight: a doc that had settled as "failed" is RESUMED —
 *     back to building, attempts reset, one new QStash chain. A doc that is
 *     already queued/building only has its stage refreshed: its chain is
 *     taken to be live, so no second chain is started and its attempt count
 *     (the poll cap) is left alone. Otherwise every click would add a chain
 *     and push the cap out again, without bound.
 *
 * Writes go through `transitionWebsite`, guarded on the job this request
 * read: a `ready` site is never written over, and a site reset or rebuilt
 * while this request was talking to gitpage is left as it now is.
 *
 * Returns the resolved/intermediate state so the caller can update the UI
 * without waiting for Firestore to fan-out.
 *
 * No `websiteEnabledByAgency` check, on purpose (there has never been one
 * here): it only finishes a build already accepted. Why: settleWebsiteBuild.
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

  /** What the site is NOW, for a request whose own write did not apply. */
  const reportCurrent = async () => {
    const now = (await docRef.get()).data() as WebsiteDoc | undefined;
    const sameJob = now?.gitpageJobId === formResponseId;
    if (sameJob && now?.status === "ready") {
      return NextResponse.json({ ok: true, settled: "ready", liveUrl: now.liveUrl });
    }
    if (sameJob && now?.status === "failed") {
      return NextResponse.json({ ok: true, settled: "failed", errorMessage: now.errorMessage });
    }
    return NextResponse.json({ ok: true, ignored: "not-in-flight", status: now?.status ?? null });
  };
  /** Any state this request may act on: in flight, or failed and resumable. */
  const recheckableStates = [...WEBSITE_IN_FLIGHT, "failed" as const];

  let pollResult;
  try {
    pollResult = await pollBuild(formResponseId);
  } catch (err) {
    if (err instanceof GitpageError && err.status === 401) {
      await markGitpageKeyInvalid();
    }
    if (err instanceof GitpageError && err.status >= 400 && err.status < 500) {
      const rejected = await transitionWebsite(
        docRef,
        { expectJobId: formResponseId, fromStatuses: recheckableStates },
        {
          status: "failed",
          errorMessage: `gitpage rejected the poll: ${err.message.slice(0, 300)}`,
          updatedAt: FieldValue.serverTimestamp(),
        },
      );
      if (!rejected.applied) return reportCurrent();
      return NextResponse.json({ ok: true, settled: "client-error" });
    }
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Poll request failed.",
      },
      { status: 502 },
    );
  }

  if (isSettleable(pollResult)) {
    // Same settle path as the QStash tick + the build.settled callback, so
    // a premium hand-off also runs when the operator re-checks by hand.
    const settled = await settleWebsiteBuild({
      subAccountId,
      siteId,
      site: websiteDoc,
      result: pollResult,
      attempts: websiteDoc.pollAttempts ?? 0,
    });
    // "noop": another path settled it first, or this is the report already
    // applied. Either way the doc holds the answer.
    if (settled === "noop") return reportCurrent();
    return NextResponse.json({
      ok: true,
      settled,
      ...(settled === "ready"
        ? { liveUrl: pollResult.pagesUrl }
        : { errorMessage: pollResult.error }),
    });
  }

  // Still in flight (or Published with no live URL yet).
  if (websiteDoc.status === "failed") {
    // Resume: the doc gave up (poll-cap timeout, a dead chain) but gitpage
    // says the job is still running. Back to building, a fresh window, and
    // the ONE new chain — only this transition starts one.
    const resumed = await transitionWebsite(
      docRef,
      { expectJobId: formResponseId, fromStatuses: ["failed"] },
      {
        status: "building",
        statusPhase: pollResult.statusPhase,
        errorMessage: null,
        pollAttempts: 0,
        updatedAt: FieldValue.serverTimestamp(),
      },
    );
    if (!resumed.applied) return reportCurrent();

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
      status: "building",
      statusPhase: pollResult.statusPhase,
      rescheduled,
    });
  }

  // Queued or building: refresh the stage only. No new chain, and the
  // attempt count stays where the live chain has it.
  const nextStatus =
    pollResult.statusPhase && pollResult.statusPhase !== "processing"
      ? "building"
      : websiteDoc.status;
  const refreshed = await transitionWebsite(
    docRef,
    { expectJobId: formResponseId, fromStatuses: WEBSITE_IN_FLIGHT },
    {
      status: nextStatus,
      statusPhase: pollResult.statusPhase,
      updatedAt: FieldValue.serverTimestamp(),
    },
  );
  if (!refreshed.applied) return reportCurrent();

  return NextResponse.json({
    ok: true,
    deferred: "in-flight",
    status: nextStatus,
    statusPhase: pollResult.statusPhase,
    rescheduled: false,
  });
}
