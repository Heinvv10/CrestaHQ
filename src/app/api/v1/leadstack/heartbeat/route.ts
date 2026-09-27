import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { LANDING_VARIANT } from "@/config/landing";
import { sendNewInstanceAlert } from "@/lib/affiliate/instances-data";
import { clientIpFrom } from "@/lib/checkout/rate-limit";
import { createFixedWindowLimiter } from "@/lib/server/fixed-window-limit";
import { isDocId } from "@/lib/server/doc-id";
import { readBodyCapped } from "@/lib/api/body-limit";

export const dynamic = "force-dynamic";

/**
 * Mothership heartbeat RECEIVER.
 *
 * Every LeadStack deployment (this one + every buyer clone) POSTs a small
 * liveness payload here on cold start and once daily. We upsert one row per
 * `instanceId` into `leadstackInstances/{instanceId}` so the agency owner's
 * "Instances" fleet view can show which deployments are live, their bootstrap
 * email, platform, version, and last-seen time.
 *
 * Auth model: intentionally open (machine-to-machine from arbitrary buyer
 * deployments — there's no shared secret to distribute). It's low-risk write-
 * only telemetry: idempotent per `instanceId`, all fields length-capped, and
 * the collection is server-only in Firestore rules. Worst case is a junk row,
 * which the fleet view's last-seen filtering ages out.
 *
 * The response mirrors the shape the sender expects
 * (`{ ok, gitpageStatus: { agency } }`) so a deployment that points its whole
 * heartbeat here (via GITPAGE_API_URL) still parses a valid response. We don't
 * gate anything on `agency` from the mothership — it's always false here; the
 * real gitpage subscription check stays with gitpage.
 *
 * License directive: the response also carries `license.status` — "revoked"
 * when the operator has flagged this instance in the fleet view (the sender
 * only honors it during its 14-day provisional window; see
 * lib/license/license.ts), "ok" otherwise. Every fallback path answers "ok"
 * so a receiver hiccup can never lock a healthy deployment.
 *
 * Public path: covered by the `/api/v1` prefix already in middleware
 * PUBLIC_PATHS (auth happens in-route, not via session cookie).
 *
 * Rate limit: 30 an hour per client IP. A real deployment pings on cold start
 * and once a day; the limit only bounds a script's writes and new-instance
 * alert emails. A 429 is safe for the sender — it reads any non-2xx as "no
 * directive" (lib/gitpage/heartbeat.ts).
 */

const checkHeartbeatRateLimit = createFixedWindowLimiter({
  limit: 30,
  windowMs: 60 * 60 * 1000,
});

const OK_RESPONSE = {
  ok: true,
  gitpageStatus: { agency: false },
  license: { status: "ok" },
} as const;

/** Trim + hard-cap a string field so a malformed payload can't bloat a doc. */
function cap(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function finiteInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

export async function POST(request: Request) {
  const rate = checkHeartbeatRateLimit(clientIpFrom(request));
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
    );
  }

  // The sender's payload (lib/gitpage/heartbeat.ts) is nine short fields,
  // well under 1 KB; 16 KB bounds a keyless caller without ever refusing a
  // real deployment.
  const raw = await readBodyCapped(request, 16 * 1024);
  if (raw === null) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const instanceId = cap(body.instanceId, 128);
  const ownerEmail = cap(body.ownerEmail, 320);

  // instanceId is the doc key; ownerEmail is the whole point of the record.
  // Missing either → accept the ping (so the sender never treats us as down)
  // but persist nothing.
  if (!instanceId || !ownerEmail) {
    return NextResponse.json(OK_RESPONSE);
  }
  // Reject an instanceId that can't be a Firestore doc id.
  if (!isDocId(instanceId)) {
    return NextResponse.json(OK_RESPONSE);
  }

  const version = cap(body.version, 32);
  const platform = cap(body.platform, 32);
  const subAccountCount = finiteInt(body.subAccountCount);
  const hasGitpageKey = body.hasGitpageKey === true;
  const licenseState =
    body.licenseState === "provisional" || body.licenseState === "validated"
      ? body.licenseState
      : null;

  let revoked = false;
  try {
    const ref = getAdminDb().collection("leadstackInstances").doc(instanceId);
    const existing = await ref.get();
    revoked = existing.exists && existing.data()?.revoked === true;

    const fields: Record<string, unknown> = {
      instanceId,
      ownerEmail,
      version,
      platform,
      hasGitpageKey,
      lastSeenAt: FieldValue.serverTimestamp(),
      heartbeatCount: FieldValue.increment(1),
    };
    // subAccountCount is only present on the daily cron ping — don't overwrite
    // a known count back to null on a boot ping that omits it.
    if (subAccountCount !== null) fields.subAccountCount = subAccountCount;
    // Only versions carrying license enforcement report this — its absence
    // tells the fleet view a revoke directive would have no effect.
    if (licenseState !== null) fields.licenseState = licenseState;

    if (!existing.exists) {
      fields.firstSeenAt = FieldValue.serverTimestamp();
      if (subAccountCount === null) fields.subAccountCount = null;
    }

    await ref.set(fields, { merge: true });

    // First heartbeat from an unknown instance → alert the operator so the
    // review happens inside the sender's revocation window. Mothership-only
    // behavior; best-effort (the helper swallows its own errors).
    if (!existing.exists && LANDING_VARIANT === "leadstack") {
      await sendNewInstanceAlert({
        instanceId,
        ownerEmail,
        platform,
        version,
        licenseState,
      });
    }
  } catch (err) {
    // Never fail the sender — telemetry ingestion must not error a deploy's
    // boot path. Log and return OK (which also reads as "not revoked").
    console.warn("[mothership/heartbeat] persist failed", err);
    return NextResponse.json(OK_RESPONSE);
  }

  return NextResponse.json({
    ...OK_RESPONSE,
    license: { status: revoked ? "revoked" : "ok" },
  });
}
