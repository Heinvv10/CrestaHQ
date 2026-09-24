import "server-only";

import {
  CapabilityUserError,
  type AiSuiteActionContext,
  type ExecuteResult,
} from "@/lib/ai-suite/capabilities";
import { getAdminDb } from "@/lib/firebase/admin";
import { reserveEnrolment, resolveEnrolmentCapPerHour } from "@/lib/api/enrolment-cap";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import type { WorkflowTriggerType } from "@/types/workflows";

const WHY: Record<string, string> = {
  no_active_workflow: "That workflow is no longer active, so nobody was enrolled.",
  contact_not_found: "That contact no longer exists in this workspace.",
  automations_paused: "Automations are paused for this workspace.",
  reentry_blocked: "The contact is already in (or has already been through) that workflow.",
  filters_not_met: "The contact no longer matches that workflow's filters.",
  trigger_mismatch: "The workflow's trigger no longer matches.",
};

/**
 * Approving a `workflow_enrolment` proposal replays the held trigger for its
 * one workflow — it never re-runs the capability that caused it (that would
 * redo the write). The enrolment is charged to the proposing key's hourly
 * cap here, at approve (ruling Q); the engine's `finally` reconciles it.
 * Everything the engine checks — active, filters, re-entry in its
 * run-creating transaction — runs again now.
 */
export async function replayHeldEnrolment(
  proposal: Record<string, unknown>,
  _approver: AiSuiteActionContext
): Promise<ExecuteResult> {
  const args = proposal.args as { type: WorkflowTriggerType; contactId: string; context?: Record<string, unknown> };
  const subAccountId = proposal.subAccountId as string;
  const keyId = proposal.keyId as string;
  const workflowId = proposal.workflowId as string;
  const key = (await getAdminDb().doc(`subAccounts/${subAccountId}/apiKeys/${keyId}`).get()).data();
  const budget = await reserveEnrolment({
    subAccountId,
    keyId,
    limit: resolveEnrolmentCapPerHour(key?.enrolmentCapPerHour),
  });
  if (!budget.allowed) {
    throw new CapabilityUserError(
      `This key has used its ${budget.limit} workflow enrolments for this hour; approve again after the hour turns.`
    );
  }
  const outcome = await fireWorkflowTrigger({
    subAccountId,
    agencyId: proposal.agencyId as string,
    type: args.type,
    contactId: args.contactId,
    context: args.context ?? {},
    onlyWorkflowId: workflowId,
    // Only a charged reservation is reconciled by the engine's finally.
    ...(budget.charged ? { apiKeyId: keyId } : {}),
  });
  const run = outcome.enrolled[0];
  if (run) {
    return {
      resultText: `Enrolled the contact in the workflow${run.status === "failed" ? ", but its first step could not be scheduled" : ""}.`,
      ref: { kind: "workflowRun", id: run.runId },
    };
  }
  const reason = outcome.reason ?? outcome.skipped[0]?.reason ?? "no_active_workflow";
  throw new CapabilityUserError(WHY[reason] ?? "The enrolment could not be started.");
}
