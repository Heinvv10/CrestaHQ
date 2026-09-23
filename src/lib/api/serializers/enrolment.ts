import type { EnrolSkipReason, TriggerOutcome } from "@/lib/workflows/engine";

/**
 * The `enrolment` block the v1 contact upsert returns: what adding
 * `tags_add` did, answered synchronously so the caller never polls for it.
 * It describes the `contact.tag.added` trigger only — a `contact.created`
 * workflow still runs on a create, but is not the question being asked.
 */
export type EnrolmentReason =
  /** A test-mode key: nothing is ever enrolled. */
  | "test_mode"
  /** Every tag in tags_add was already on the contact, so no trigger fired. */
  | "tag_already_present"
  | "automations_paused"
  /** No active workflow starts on this tag. */
  | "no_matching_workflow"
  /** A workflow starts on this tag, but its filters excluded the contact. */
  | "filters_not_met"
  /** A workflow matched, but its re-entry policy refused a second run. */
  | "reentry_blocked"
  /** A run was created but its first step could not be scheduled. */
  | "run_failed"
  | "error";

export interface EnrolmentApiObject {
  status: "enrolled" | "not_enrolled";
  /** Null exactly when status is "enrolled". */
  reason: EnrolmentReason | null;
  runs: Array<{ workflow_id: string; run_id: string; status: "running" | "failed" }>;
  skipped: Array<{ workflow_id: string; reason: EnrolSkipReason }>;
}

const none = (reason: EnrolmentReason): EnrolmentApiObject => ({
  status: "not_enrolled",
  reason,
  runs: [],
  skipped: [],
});

export function describeEnrolment(input: {
  mode: "live" | "test";
  /** The settled `contact.tag.added` outcome, or null when it never fired. */
  tagTrigger: TriggerOutcome | null;
}): EnrolmentApiObject {
  if (input.mode === "test") return none("test_mode");
  const t = input.tagTrigger;
  if (!t) return none("tag_already_present");

  const runs = t.enrolled.map((r) => ({
    workflow_id: r.workflowId,
    run_id: r.runId,
    status: r.status,
  }));
  const skipped = t.skipped.map((s) => ({ workflow_id: s.workflowId, reason: s.reason }));
  const reason = ((): EnrolmentReason | null => {
    if (runs.some((r) => r.status === "running")) return null;
    if (runs.length > 0) return "run_failed";
    if (t.reason === "automations_paused") return "automations_paused";
    if (t.reason === "error" || t.reason === "contact_not_found") return "error";
    if (skipped.some((s) => s.reason === "reentry_check_failed")) return "error";
    if (skipped.some((s) => s.reason === "reentry_blocked")) return "reentry_blocked";
    if (skipped.some((s) => s.reason === "filters_not_met")) return "filters_not_met";
    return "no_matching_workflow";
  })();
  return { status: reason === null ? "enrolled" : "not_enrolled", reason, runs, skipped };
}
