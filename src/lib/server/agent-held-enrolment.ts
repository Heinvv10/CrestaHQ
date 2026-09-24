import "server-only";

import { createProposal } from "@/lib/server/agent-proposals";
import type { FireInput } from "@/lib/workflows/engine";
import type { HeldEnrolment } from "@/lib/workflows/agent-hold";
import type { WorkflowDoc } from "@/types/workflows";

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
  const created = await createProposal({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    keyId: hold.keyId,
    keyPrefix: hold.keyPrefix,
    capability: hold.capability,
    approval: "workflow_enrolment",
    args: { type: input.type, contactId: contact.id, context: input.context ?? {} },
    workflowId: wf.id,
    summary: `Enrol “${contactName}” in the workflow “${wf.name}”.`,
    preview: [
      { label: "Workflow", value: wf.name },
      { label: "Trigger", value: input.type },
      { label: "Contact", value: contactName },
    ],
    pinned: { workflowId: wf.id, contactId: contact.id },
    // territoryId is re-read from the contact inside createProposal's transaction.
    target: { contactId: contact.id, territoryId: null, scoped: true },
  });
  if (!created.ok) return null;
  return { proposalId: created.id, workflowId: wf.id, workflowName: wf.name };
}
