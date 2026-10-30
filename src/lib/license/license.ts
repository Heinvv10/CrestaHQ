import "server-only";

import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Provisional-license window.
 *
 * A fresh deployment runs in a "provisional" state for its first 14 days
 * (anchored at the first attributable heartbeat — see lib/gitpage/heartbeat).
 * During that window the template vendor can flag the license invalid via the
 * heartbeat response, which locks the operator dashboard on this deployment.
 * Once the window passes without a revocation the deployment is permanently
 * VALIDATED: the flag is never honored again, by construction. This backs the
 * license-compliance verification disclosed in the Terms of Service while
 * keeping the ownership promise structural for validated deployments.
 *
 * Fail-open by design: a missing/unreachable heartbeat response, a Firestore
 * error, or an absent `system/license` doc all resolve to "not revoked" — a
 * network blip can never lock a working deployment.
 *
 * State doc: `system/license` (server-only in Firestore rules).
 */

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type LicenseState = "provisional" | "validated";
export type LicenseDirective = "ok" | "revoked";

interface LicenseDocData {
  provisionalSince?: Timestamp;
  validatedAt?: Timestamp | null;
  revoked?: boolean;
}

function licenseRef() {
  return getAdminDb().doc("system/license");
}

// Short-lived in-memory cache so the dashboard layout guard doesn't cost a
// Firestore read on every navigation. Serverless instances are short-lived;
// 60s staleness only delays a lock/unlock by at most a minute past the
// heartbeat that applied it.
let cachedRevoked: { value: boolean; at: number } | null = null;
const CACHE_MS = 60 * 1000;

function bustCache(): void {
  cachedRevoked = null;
}

/**
 * Create the window anchor on first call and resolve the current state.
 * Called from the heartbeat path only (the read guards never write). A
 * revoked deployment never transitions to validated — clearing the flag
 * (an "ok" directive) must happen first.
 */
export async function ensureLicenseAnchor(): Promise<LicenseState> {
  const ref = licenseRef();
  const snap = await ref.get();
  const data = (snap.exists ? snap.data() : undefined) as
    | LicenseDocData
    | undefined;

  if (!data?.provisionalSince) {
    await ref.set(
      { provisionalSince: FieldValue.serverTimestamp(), revoked: false },
      { merge: true },
    );
    return "provisional";
  }
  if (data.validatedAt) return "validated";
  if (data.revoked === true) return "provisional";

  if (Date.now() - data.provisionalSince.toMillis() >= WINDOW_MS) {
    await ref.set(
      { validatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return "validated";
  }
  return "provisional";
}

/**
 * Apply the heartbeat response's license directive. No-ops once validated
 * (the window has closed — revocations are no longer honored) and writes
 * only on actual transitions. An "ok" directive clears a prior revocation,
 * so a mistaken flag recovers on the next heartbeat.
 */
export async function applyLicenseDirective(
  directive: LicenseDirective,
): Promise<void> {
  const ref = licenseRef();
  const snap = await ref.get();
  const data = (snap.exists ? snap.data() : undefined) as
    | LicenseDocData
    | undefined;
  if (data?.validatedAt) return;
  const currentlyRevoked = data?.revoked === true;

  if (directive === "revoked" && !currentlyRevoked) {
    await ref.set(
      { revoked: true, revokedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    bustCache();
  } else if (directive === "ok" && currentlyRevoked) {
    await ref.set(
      { revoked: false, restoredAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    bustCache();
  }
}

/**
 * Read guard for the layout gates. Never throws and never writes — any
 * error reads as "not revoked" so a Firestore blip can't lock the app.
 */
export async function isLicenseRevoked(): Promise<boolean> {
  if (cachedRevoked && Date.now() - cachedRevoked.at < CACHE_MS) {
    return cachedRevoked.value;
  }
  try {
    const snap = await licenseRef().get();
    const data = (snap.exists ? snap.data() : undefined) as
      | LicenseDocData
      | undefined;
    const value = data?.revoked === true && !data?.validatedAt;
    cachedRevoked = { value, at: Date.now() };
    return value;
  } catch {
    return false;
  }
}
