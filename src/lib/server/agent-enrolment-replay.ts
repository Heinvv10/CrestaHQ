import "server-only";

import {
  CapabilityUserError,
  type AiSuiteActionContext,
  type ExecuteResult,
} from "@/lib/ai-suite/capabilities";

/**
 * Approving a `workflow_enrolment` proposal replays the held trigger for its
 * one workflow — it never re-runs the capability that caused it (that would
 * redo the write). Nothing creates these rows until PR3b (ruling Q), which
 * implements the replay; until then an approve settles `failed`.
 */
export async function replayHeldEnrolment(
  _proposal: Record<string, unknown>,
  _approver: AiSuiteActionContext
): Promise<ExecuteResult> {
  throw new CapabilityUserError(
    "Approving a held workflow enrolment is not available yet."
  );
}
