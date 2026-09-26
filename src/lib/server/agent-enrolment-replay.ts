import "server-only";

import {
  CapabilityUserError,
  type AiSuiteActionContext,
  type ExecuteResult,
} from "@/lib/ai-suite/capabilities";
import { getAdminDb } from "@/lib/firebase/admin";
import { reserveEnrolment, resolveEnrolmentCapPerHour } from "@/lib/api/enrolment-cap";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import { readPipelineStages } from "@/lib/pipelines/server";
import { dealPipelineId } from "@/lib/pipelines/stages";
import type { WorkflowTriggerType } from "@/types/workflows";
import { eventStatus, type CalendarEvent } from "@/types/events";

const WHY: Record<string, string> = {
  no_active_workflow: "That workflow is no longer active, so nobody was enrolled.",
  contact_not_found: "That contact no longer exists in this workspace.",
  automations_paused: "Automations are paused for this workspace.",
  reentry_blocked: "The contact is already in (or has already been through) that workflow.",
  filters_not_met: "The contact no longer matches that workflow's filters.",
  trigger_mismatch: "The workflow's trigger no longer matches.",
  deal_changed:
    "The deal changed since this was proposed (it moved, left its pipeline or was deleted), so nobody was enrolled (trigger_mismatch).",
  event_changed:
    "The appointment's status changed since this was proposed (or it was deleted), so nobody was enrolled (trigger_mismatch).",
};

/** Booking triggers an agent's status change holds, and the status each needs at replay. */
const BOOKING_STATUS: Record<string, string> = { "booking.showed": "completed", "booking.no_show": "no_show" };

/** A held booking trigger replays only while the event is still in this sub-account with that status. */
export async function eventStillMatches(subAccountId: string, type: string, context: Record<string, unknown>): Promise<boolean> {
  const event = (await getAdminDb().doc(`events/${String(context.eventId)}`).get()).data();
  return !!event && event.subAccountId === subAccountId && eventStatus(event as Pick<CalendarEvent, "status">) === BOOKING_STATUS[type];
}

/** Deal triggers a held enrolment re-checks at replay (and the approvals list mirrors). */
export const DEAL_TRIGGERS = new Set(["deal.created", "deal.won", "deal.lost", "pipeline.stage.changed"]);

/**
 * A held deal trigger replays only while its fact is still true. Every deal
 * trigger needs the deal to still exist in this sub-account. `deal.created`
 * needs nothing more (a deal moved since is still a new deal: speed-to-lead
 * stays approvable); a stage change or won/lost needs the same stage and
 * pipeline, and won/lost a stage with that terminal flag.
 */
export async function dealStillMatches(
  subAccountId: string,
  type: string,
  context: Record<string, unknown>
): Promise<boolean> {
  const snap = await getAdminDb().doc(`deals/${String(context.dealId)}`).get();
  const deal = snap.data();
  if (!deal || deal.subAccountId !== subAccountId) return false;
  if (type === "deal.created") return true;
  if (deal.stageId !== context.toStage) return false;
  if (dealPipelineId(deal) !== context.pipelineId) return false;
  if (type === "deal.won" || type === "deal.lost") {
    // Read-only: the approvals list shows this same verdict from a GET.
    const stages = await readPipelineStages(subAccountId, dealPipelineId(deal));
    const stage = stages?.find((s) => s.id === deal.stageId);
    return stage?.terminal === type.slice("deal.".length);
  }
  return true;
}

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
  if (DEAL_TRIGGERS.has(args.type) && !(await dealStillMatches(subAccountId, args.type, args.context ?? {}))) {
    throw new CapabilityUserError(WHY.deal_changed);
  }
  if (args.type in BOOKING_STATUS && !(await eventStillMatches(subAccountId, args.type, args.context ?? {}))) {
    throw new CapabilityUserError(WHY.event_changed);
  }
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
