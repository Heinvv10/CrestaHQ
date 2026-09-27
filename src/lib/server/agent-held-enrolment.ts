import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { createProposal } from "@/lib/server/agent-proposals";
import { normalizePreview } from "@/lib/server/agent-proposals-encoding";
import { readableJson, workflowStepsFingerprint } from "@/lib/ai-suite/capabilities/workflow-support";
import type { PreviewRow } from "@/lib/ai-suite/capabilities/types";
import type { FireInput } from "@/lib/workflows/engine";
import type { HeldEnrolment } from "@/lib/workflows/agent-hold";
import type { WorkflowDoc } from "@/types/workflows";

/** The workflow's exact steps and when they start, and their fingerprint. */
function stepsRows(wf: WorkflowDoc): PreviewRow[] {
  return [
    { label: "Steps (exact)", value: readableJson({ startNodeId: wf.startNodeId ?? null, nodes: wf.nodes ?? {} }), multiline: true },
    { label: "When", value: "The first step runs as soon as this is approved." },
  ];
}
const STEPS_LABELS = new Set(stepsRows({ nodes: {} } as unknown as WorkflowDoc).map((r) => r.label));

/**
 * What an approver reads for a held enrolment: the workflow, trigger and
 * contact (and a deal trigger's deal and stage), then the workflow's exact
 * steps and when they start. Pins the steps' fingerprint, so a steps edit
 * after the hold makes the approve a `preview_changed` (the decide route
 * rebuilds the steps rows) and the replay refuses one made after approval.
 */
async function heldEnrolmentPreview(
  args: { type: string; contactId: string; context?: Record<string, unknown> },
  wf: WorkflowDoc,
  contactName: string
) {
  const dealId = args.context?.dealId;
  const deal =
    typeof dealId === "string" ? (await getAdminDb().doc(`deals/${dealId}`).get()).data() : undefined;
  const rows: PreviewRow[] = [
    { label: "Workflow", value: wf.name },
    { label: "Trigger", value: args.type },
    { label: "Contact", value: contactName },
    ...(deal
      ? [
          { label: "Deal", value: String(deal.title ?? dealId) },
          { label: "Stage", value: String(args.context?.toStage ?? deal.stageId) },
        ]
      : []),
    ...stepsRows(wf),
  ];
  return normalizePreview({
    rows,
    pinned: { workflowId: wf.id, contactId: args.contactId, stepsFingerprint: workflowStepsFingerprint(wf) },
  });
}

/**
 * Write one held enrolment (ruling Q) through the same approval queue as
 * every agent proposal: approval `workflow_enrolment`, one row per matched
 * workflow (the id hashes `workflowId`), targeting the contact so the row is
 * territory-scoped like it. The args ARE the stored trigger input that
 * approve replays for this one workflow. Null when the queue refuses (an
 * earlier approval of it is unsettled, or the key was revoked).
 */
export async function writeHeldEnrolment(
  input: FireInput,
  wf: WorkflowDoc,
  contact: { id: string; name?: string }
): Promise<HeldEnrolment | null> {
  const hold = input.hold!;
  const contactName = contact.name || "this contact";
  const args = { type: input.type, contactId: contact.id, context: input.context ?? {} };
  const { rows, pinned } = await heldEnrolmentPreview(args, wf, contactName);
  const created = await createProposal({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    keyId: hold.keyId,
    keyPrefix: hold.keyPrefix,
    capability: hold.capability,
    approval: "workflow_enrolment",
    args,
    workflowId: wf.id,
    summary: `Enrol “${contactName}” in the workflow “${wf.name}”.`,
    preview: rows,
    pinned: pinned!,
    // territoryId is re-read from the contact inside createProposal's transaction.
    target: { contactId: contact.id, territoryId: null, scoped: true },
  });
  if (!created.ok) return null;
  return { proposalId: created.id, workflowId: wf.id, workflowName: wf.name };
}

/** The held enrolment's preview with its steps rows and fingerprint as they
 *  read now (everything else as proposed: a deal or contact that changed
 *  is the replay's to judge), for the decide route to compare with the
 *  stored one. Null when the workflow is gone (the replay reports it). */
export async function currentHeldEnrolmentPreview(proposal: Record<string, unknown>) {
  const snap = await getAdminDb().doc(`workflows/${String(proposal.workflowId)}`).get();
  if (!snap.exists || snap.data()?.subAccountId !== proposal.subAccountId) return null;
  const wf = { ...(snap.data() as Omit<WorkflowDoc, "id">), id: snap.id } as WorkflowDoc;
  const kept = ((proposal.preview ?? []) as PreviewRow[]).filter((r) => !STEPS_LABELS.has(r.label));
  return normalizePreview({
    rows: [...kept, ...stepsRows(wf)],
    pinned: { ...((proposal.pinned ?? {}) as Record<string, unknown>), stepsFingerprint: workflowStepsFingerprint(wf) },
  });
}
