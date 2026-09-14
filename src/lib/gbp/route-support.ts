import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { googleGateOn } from "@/lib/google/gate";
import { googleAppConfigured } from "@/lib/google/oauth";
import type { SubAccountDoc } from "@/types";
import { ACCESS_NOT_APPROVED_TEXT } from "./error-text";
import { GbpProviderError } from "./provider/types";
import { GbpNotConnectedError } from "./tokens";

/**
 * Shared preconditions and error mapping for the GBP routes that talk to
 * Google on an admin's behalf. Every refusal is a `{error, code}` body with a
 * fixed message — never a provider body, a token or a Firestore path.
 */

export function gbpRefusal(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status });
}

/**
 * Gate, deployment config and connection state, in that order. Returns the
 * sub-account doc when the route may go on to call Google.
 */
export async function gbpPreconditions(
  subAccountId: string,
): Promise<{ sub: SubAccountDoc } | NextResponse> {
  if (!(await googleGateOn(subAccountId))) {
    return gbpRefusal(403, "gate_off", "This feature is locked by your agency.");
  }
  if (!googleAppConfigured()) {
    return gbpRefusal(503, "not_configured", "Google isn't configured on this deployment.");
  }
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = (snap.data() ?? {}) as SubAccountDoc;
  if (!sub.googleConnectionMeta?.connected) {
    return gbpRefusal(409, "not_connected", "Google Business Profile is not connected.");
  }
  if (sub.googleConnectionMeta.reconnectRequired) {
    return gbpRefusal(409, "reconnect_required", "Reconnect Google Business Profile.");
  }
  return { sub };
}

/**
 * Map a failure from the token lifecycle or the provider to a response.
 * Anything that is not one of ours (a bug, a refused fake) is rethrown: a 500
 * is the honest answer, and it must not be dressed up as a Google outage.
 */
export async function gbpErrorResponse(
  err: unknown,
  subAccountId: string,
  route: string,
): Promise<NextResponse> {
  if (err instanceof GbpNotConnectedError) {
    return gbpRefusal(409, "not_connected", "Google Business Profile is not connected.");
  }
  if (!(err instanceof GbpProviderError)) throw err;

  console.warn(`[${route}] provider error sa=${subAccountId} kind=${err.kind} status=${err.status ?? "-"}`);
  if (err.kind === "revoked" || err.kind === "insufficient_scope") {
    // Already flagged where it was detected (tokens.ts / withGbpAccess), and
    // only if the failed credential was still the stored one.
    return gbpRefusal(409, "reconnect_required", "Reconnect Google Business Profile.");
  }
  // 424, not 502: crm.crestahq.com is behind Cloudflare, which replaces an
  // origin 502 / 504 with its own HTML page — the `{error, code}` body never
  // reached the browser (#1000's picker read "(error)" for a logged 429).
  return gbpRefusal(424, err.kind, err.kind === "access_not_approved" ? ACCESS_NOT_APPROVED_TEXT : "Google request failed");
}
