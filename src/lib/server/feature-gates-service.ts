import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { removeSendingDomain } from "@/lib/comms/resend-domains";
import { metaAppConfigured } from "@/lib/comms/meta";
import { clearGbpCache } from "@/lib/gbp/sync/store";
import type { ResendConfig } from "@/types";
import type { PlanGateKey } from "@/types/billing";

/**
 * Shared gate-application chokepoint — the ONE place that flips
 * `*EnabledByAgency` fields on a sub-account doc. Two callers:
 *
 *   1. The manual PATCH route (/api/agency/sub-accounts/[id]/feature-gates,
 *      driven by the Manage-dialog checkboxes).
 *   2. The billing service (Client Billing v1) — assigning/activating a plan
 *      applies the plan's gate bundle through this same function.
 *
 * Extracted so per-gate side effects (today: the email-domain tear-down)
 * can never drift between the two paths.
 *
 * Behavior notes:
 *   - Disabling the email-domain gate tears down the live Resend domain and
 *     clears `resendConfig` (frees the agency's Resend slot). Runtime
 *     `tenantFrom()` short-circuits on the falsy gate even if the cleanup
 *     blips.
 *   - The Meta gates (inbox + Social Planner) can't be enabled while the
 *     deployment has no META_APP_ID/SECRET. The manual route pre-rejects
 *     with a 400; a plan application instead writes `false` and reports the
 *     key in `skippedMetaGates` so activation never hard-fails on a
 *     deployment-config gap.
 *   - Every other gate is a plain boolean write (no tear-down) — matching
 *     the documented per-gate behavior in CLAUDE.md.
 */

/**
 * Every agency gate field the manual route can flip. Plans manage the
 * PlanGateKey subset; Get Leads (parked) is manual-only but still routes
 * through this service from the PATCH route.
 */
/**
 * Gates the agency can flip. `PlanGateKey` covers everything a Client Billing
 * plan can bundle; the extras are standalone gates deliberately kept OUT of
 * plans — Get Leads because it's parked, Payments because a plan silently
 * switching a money rail on or off is a worse failure than a manual toggle.
 * Promote either into `PLAN_GATE_KEYS` if that changes.
 */
export type AgencyGateField =
  | PlanGateKey
  | "getLeadsEnabledByAgency"
  | "paymentsEnabledByAgency"
  // Webinar1 external-platform connection — standalone like Payments (an
  // outside integration is an explicit per-client decision, not a plan perk).
  | "webinar1EnabledByAgency"
  // Google Business Profile OAuth connection — standalone for the same reason
  // as Webinar1: an outside account link is an explicit per-client decision.
  | "googleEnabledByAgency"
  // Per-member Google Calendar sync — standalone for the same reason.
  | "googleCalendarEnabledByAgency";

export interface ApplyGatesResult {
  /** True when a live Resend sending domain was removed by the email disable. */
  clearedDomain: boolean;
  /** Meta gates the plan wanted ON but the deployment can't enable. */
  skippedMetaGates: PlanGateKey[];
}

const META_GATES: ReadonlySet<AgencyGateField> = new Set([
  "metaInboxEnabledByAgency",
  "socialPlannerEnabledByAgency",
  // The AI auto-reply gate is useless without the Meta app creds the inbox
  // itself needs — same skip-on-unconfigured treatment.
  "metaAgentEnabledByAgency",
]);

export async function applyFeatureGates(
  subAccountId: string,
  gates: Partial<Record<AgencyGateField, boolean>>
): Promise<ApplyGatesResult> {
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const subSnap = await subRef.get();
  if (!subSnap.exists) {
    throw new Error(`Sub-account ${subAccountId} not found`);
  }
  const existingCfg = subSnap.data()?.resendConfig as
    | ResendConfig
    | null
    | undefined;

  const updates: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  const result: ApplyGatesResult = {
    clearedDomain: false,
    skippedMetaGates: [],
  };

  const metaConfigured = metaAppConfigured();

  for (const [key, wanted] of Object.entries(gates) as Array<
    [AgencyGateField, boolean | undefined]
  >) {
    if (typeof wanted !== "boolean") continue;

    if (key === "emailDomainEnabledByAgency" && !wanted) {
      // Tear down the live sending domain so the agency doesn't keep paying
      // for a Resend slot the sub-account can no longer use.
      if (existingCfg?.domainId) {
        await removeSendingDomain(existingCfg.domainId);
        result.clearedDomain = true;
      }
      updates.emailDomainEnabledByAgency = false;
      updates.resendConfig = null;
      continue;
    }

    if (wanted && META_GATES.has(key) && !metaConfigured) {
      updates[key] = false;
      result.skippedMetaGates.push(key as PlanGateKey);
      continue;
    }

    updates[key] = wanted;
  }

  await subRef.update(updates);
  // Google Business gate OFF → the synced review cache goes now, on every
  // path that switches it (Manage dialog route, Workspace Assistant): Google's
  // 30-day storage rule must not wait for a sweep. After the gate write, so a
  // sync starting meanwhile is refused by its lease check. The connection and
  // listing stay — re-enabling resumes with a fresh sync.
  // A failed clear does not fail the gate (already written): the daily
  // retention sweep is the backstop, and re-saving the gate retries safely.
  // Reviews AI switched ON (from off): forget the last complete sentiment run,
  // so the next sync classifies the existing reviews instead of waiting 24 h.
  if (gates.reviewsAiEnabledByAgency === true && subSnap.data()?.reviewsAiEnabledByAgency !== true) {
    try {
      await db.doc(`subAccounts/${subAccountId}/private/sentimentLease`).set({ lastCompleteAt: FieldValue.delete() }, { merge: true });
    } catch (err) {
      console.error(`[feature-gates] sentiment reset failed sa=${subAccountId} kind=${err instanceof Error ? err.name : typeof err}`);
    }
  }
  if (gates.googleEnabledByAgency === false) {
    try {
      await clearGbpCache(subAccountId);
    } catch (err) {
      console.error(
        `[feature-gates] GBP cache clear failed sa=${subAccountId} kind=${err instanceof Error ? err.name : typeof err}`,
      );
    }
  }
  return result;
}
