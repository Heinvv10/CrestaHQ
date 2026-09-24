import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  publishCallback,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { sweepOldWatchdogRuns } from "@/lib/server/agents-watchdog-service";
import { sweepAgentProposals } from "@/lib/server/agent-proposals";

/**
 * Daily cleanup sweep for the public API's TTL'd collections.
 *
 * Replaces Firestore native TTL policies — those would require the buyer
 * to click into the Firebase console after cloning, which breaks the
 * "configure env vars, run firebase deploy --only firestore:rules, done"
 * onboarding model. This route does the same job using infrastructure
 * the buyer is already configuring (QStash).
 *
 * Wiring (one-time, in the QStash dashboard):
 *   Schedule: cron `0 4 * * *` (or any daily slot)
 *   Target:   ${NEXT_PUBLIC_APP_URL}/api/cron/api-cleanup
 *
 * Cost: at moderate API volume (~50k requests/month) this sweep deletes
 * ~50k apiRequestLogs/month + smaller volumes of apiIdempotency and
 * webhookEvents. Total ~$0.06/month in Firestore ops — same ballpark as
 * native TTL would cost (TTL also bills 1 delete per doc).
 *
 * Continuation: if any collection hits the per-run cap, the route
 * self-schedules a re-run in 60s. Caps the function execution time well
 * under Vercel's serverless timeout and prevents tablet-hot issues from
 * batch-deleting 100k docs in one shot.
 */

const BATCH_LIMIT = 500;
const CONTINUATION_DELAY_SEC = 60;

/**
 * Collection groups swept via `collectionGroup(name).where("expiresAt", "<", now)`
 * below. Each needs a COLLECTION_GROUP-scope ascending index on `expiresAt`
 * in firestore.indexes.json — a single-field collection index is not enough
 * for a collectionGroup query. Exported so the index-coverage test can't
 * drift from what this route actually queries.
 */
export const EXPIRES_AT_COLLECTION_GROUPS = [
  "apiRequestLogs",
  "apiIdempotency",
  "webhookEvents",
  // Consumed community magic links (one row per sign-in; dead after 15 min).
  "communityMagicLinkUses",
] as const;

// Named so the sweeps below read from this constant instead of repeating the
// string literal — a new sweep added without a matching entry here (and thus
// without an index) fails the coverage test instead of shipping silently.
const [API_REQUEST_LOGS, API_IDEMPOTENCY, WEBHOOK_EVENTS, COMMUNITY_MAGIC_LINK_USES] =
  EXPIRES_AT_COLLECTION_GROUPS;

interface SweepResult {
  collection: string;
  deleted: number;
  hitCap: boolean;
}

async function sweepFlatCollection(
  collectionGroupName: string,
  now: Date,
): Promise<SweepResult> {
  const db = getAdminDb();
  const snap = await db
    .collectionGroup(collectionGroupName)
    .where("expiresAt", "<", now)
    .limit(BATCH_LIMIT)
    .get();
  if (snap.empty) {
    return { collection: collectionGroupName, deleted: 0, hitCap: false };
  }
  // Firestore batch limit is 500 ops; we already capped at BATCH_LIMIT.
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
  return {
    collection: collectionGroupName,
    deleted: snap.size,
    hitCap: snap.size >= BATCH_LIMIT,
  };
}

/**
 * Scrub the abuse-triage PII off old review-feedback rows.
 *
 * Unlike every other sweep here this DELETES NOTHING — the customer's rating
 * and comment are the point of the record and stay forever. It only nulls
 * `submittedFromIp` + `submittedUserAgent`, which exist to triage abuse of a
 * public unauthenticated endpoint and have no value once the submission is
 * weeks old. POPIA data-minimisation: don't hold identifying data past its
 * purpose.
 */
async function scrubReviewFeedbackPii(now: Date): Promise<SweepResult> {
  const db = getAdminDb();
  // Single inequality on the write-time stamp — same shape as the other
  // sweeps here, so no composite index is needed. Scrubbing clears the field,
  // which is also what excludes the row from every later run.
  const snap = await db
    .collection("reviewFeedback")
    .where("piiExpiresAt", "<", now)
    .limit(BATCH_LIMIT)
    .get();
  if (snap.empty) {
    return { collection: "reviewFeedback/pii", deleted: 0, hitCap: false };
  }
  const batch = db.batch();
  for (const doc of snap.docs) {
    batch.update(doc.ref, {
      submittedFromIp: null,
      submittedUserAgent: null,
      piiExpiresAt: null,
    });
  }
  await batch.commit();
  return {
    collection: "reviewFeedback/pii",
    deleted: snap.size,
    hitCap: snap.size >= BATCH_LIMIT,
  };
}

async function sweepWebhookEvents(now: Date): Promise<SweepResult> {
  // webhookEvents has a `deliveries/{id}` subcollection. recursiveDelete
  // is the only safe way to remove the parent — a batch delete would
  // orphan the deliveries.
  const db = getAdminDb();
  const snap = await db
    .collectionGroup(WEBHOOK_EVENTS)
    .where("expiresAt", "<", now)
    .limit(BATCH_LIMIT)
    .get();
  if (snap.empty) {
    return { collection: WEBHOOK_EVENTS, deleted: 0, hitCap: false };
  }
  // recursiveDelete on each ref — Firestore Admin SDK throttles internally
  // to avoid hot-tablet writes. Sequential per doc keeps memory bounded;
  // for our volume this is fine. If sweep volume grows past 5k/day we'd
  // want to fan-out via QStash + parallelize. Track via the response
  // counts before that's a real concern.
  let deleted = 0;
  for (const doc of snap.docs) {
    await db.recursiveDelete(doc.ref);
    deleted += 1;
  }
  return {
    collection: WEBHOOK_EVENTS,
    deleted,
    hitCap: snap.size >= BATCH_LIMIT,
  };
}

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const valid = await verifyQStashSignature(signature, rawBody);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const startedAt = Date.now();
  const now = new Date();

  // Sweeps run sequentially, each in its OWN try: one failing sweep (e.g. a
  // collection-group index not deployed yet → FAILED_PRECONDITION) must never
  // stop the others — above all the POPIA PII scrub. Failures are logged and
  // reported in a 500 so QStash and the logs show them.
  const sweeps: Array<[string, () => Promise<SweepResult>]> = [
    [API_REQUEST_LOGS, () => sweepFlatCollection(API_REQUEST_LOGS, now)],
    [API_IDEMPOTENCY, () => sweepFlatCollection(API_IDEMPOTENCY, now)],
    [WEBHOOK_EVENTS, () => sweepWebhookEvents(now)],
    [COMMUNITY_MAGIC_LINK_USES, () => sweepFlatCollection(COMMUNITY_MAGIC_LINK_USES, now)],
    ["reviewFeedback/pii", () => scrubReviewFeedbackPii(now)],
    // Watchdog run logs older than 30 days (Labs custom agent).
    [
      "customAgents/runs",
      async () => ({
        collection: "customAgents/runs",
        deleted: await sweepOldWatchdogRuns(),
        hitCap: false,
      }),
    ],
    // Agent API approval queue: expire stale `pending` rows, flip stale
    // `executing` claims to `unsettled`. Status changes only, no deletes.
    ["agentProposals", () => sweepAgentProposals(now)],
  ];
  const results: SweepResult[] = [];
  const failures: Array<{ collection: string; message: string }> = [];
  for (const [collection, run] of sweeps) {
    try {
      results.push(await run());
    } catch (err) {
      console.error(`[cron/api-cleanup] sweep failed collection=${collection}`, err);
      failures.push({
        collection,
        message: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  const anyHitCap = results.some((r) => r.hitCap);

  // If any sweep maxed out its batch, more work is waiting. Self-schedule
  // a continuation so we keep draining without a long-running invocation.
  // The daily schedule will pick up tomorrow's work; this short-window
  // re-run is only for catching up after a spike.
  // Only when every sweep succeeded: this run answers 500 on a failure, so
  // QStash retries it — in later minutes the dedup id doesn't collapse — and
  // each retry would schedule another continuation, fanning out for as long
  // as the failure persists. Tomorrow's scheduled run picks the backlog up.
  // publishCallback never throws: null means "not queued" (no QStash, no app
  // URL, or the publish failed — e.g. the daily cap). The response reports
  // what actually happened; tomorrow's scheduled run picks the backlog up.
  let continuationScheduled = false;
  if (anyHitCap && failures.length === 0) {
    continuationScheduled = (await publishCallback({
      pathname: "/api/cron/api-cleanup",
      body: {},
      delaySeconds: CONTINUATION_DELAY_SEC,
      // Time-based dedup id so multiple continuations within the same
      // minute don't stomp each other but a healthy sweep can land its
      // next run.
      deduplicationId: `api-cleanup_continuation_${Math.floor(Date.now() / 1000 / 60)}`,
    })) !== null;
    if (!continuationScheduled) console.error("[cron/api-cleanup] continuation not queued");
  }

  return NextResponse.json(
    {
      ok: failures.length === 0,
      ...(failures.length > 0 ? { error: "sweep_failed", failures } : {}),
      durationMs: Date.now() - startedAt,
      results,
      continuationScheduled,
    },
    { status: failures.length > 0 ? 500 : 200 },
  );
}
