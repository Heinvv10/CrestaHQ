import "server-only";

import type { ApiAuthContext } from "@/lib/api/auth";
import type { AgentDispatchResult } from "@/lib/api/agent-dispatch";
import { buildPreviewContext } from "@/lib/api/agent-context";
import type { AiSuiteCapability, CapabilityApproval } from "@/lib/ai-suite/capabilities";
import { createProposal, OUTCOME_UNKNOWN_MESSAGE } from "@/lib/server/agent-proposals";
import {
  assertPinnedWhenOutbound,
  normalizePreview,
  proposalTooLarge,
} from "@/lib/server/agent-proposals-encoding";

const refuse = (code: string, httpStatus: number, message: string): AgentDispatchResult => ({
  ok: false,
  code,
  httpStatus,
  message,
});

/**
 * Queue an agent call for a person to approve (dispatch's only path for a
 * capability with an approval class). The preview is built for `target`,
 * the sub-account the action changes. A sub-account call's row belongs to
 * that sub-account; an agency-level call's row (`agencyLevel`) belongs to
 * the agency, with `subAccountId: null` and `targetSubAccountId` (D4).
 */
export async function queueProposal(input: {
  key: Pick<ApiAuthContext, "agencyId" | "keyId" | "keyPrefix" | "keyLevel">;
  cap: AiSuiteCapability;
  approval: CapabilityApproval;
  args: Record<string, unknown>;
  target: string;
  agencyLevel: boolean;
}): Promise<AgentDispatchResult> {
  const { key, cap, approval, args, target } = input;
  // The approver sees `preview` verbatim; a queued action without one
  // could not be judged, so it is a registry bug, not a proposal.
  if (!cap.preview) throw new Error(`${cap.name} has approval but no preview`);
  if (!cap.approvalTarget) throw new Error(`${cap.name} has approval but no approvalTarget`);
  const previewCtx = buildPreviewContext(key.agencyId, target);
  const approvalTarget = await cap.approvalTarget(previewCtx, args);
  const reviewed = normalizePreview(await cap.preview(previewCtx, args));
  assertPinnedWhenOutbound(cap.name, approval, reviewed);
  if (proposalTooLarge(args, reviewed)) {
    return refuse(
      "proposal_too_large",
      400,
      cap.proposalTooLargeMessage ?? "This action is too large to queue for approval. Split it into smaller changes."
    );
  }
  const created = await createProposal({
    agencyId: key.agencyId,
    subAccountId: input.agencyLevel ? null : target,
    ...(input.agencyLevel ? { targetSubAccountId: target } : {}),
    keyId: key.keyId,
    keyPrefix: key.keyPrefix,
    keyLevel: key.keyLevel,
    capability: cap.name,
    approval,
    args,
    summary: cap.summarize(args),
    preview: reviewed.rows,
    pinned: reviewed.pinned,
    target: approvalTarget,
  });
  if (!created.ok) {
    return created.code === "key_revoked"
      ? refuse("key_revoked", 401, "This API key has been revoked.")
      : refuse("outcome_unknown", 409, OUTCOME_UNKNOWN_MESSAGE);
  }
  const { id, status, summary, preview } = created;
  return { ok: true, args, proposal: { id, status, summary, preview } };
}
