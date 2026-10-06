/**
 * Client-safe types and wording for the approvals page. The decide route's
 * outcome codes (AGENT_API_V1_PLAN.md, "Approve path" REVISED block) mapped
 * to what an approver needs to read.
 */

export type ApprovalStatus =
  | "pending"
  | "executing"
  | "executed"
  | "failed"
  | "rejected"
  | "expired"
  | "unsettled";

export interface ApprovalRow {
  id: string;
  capability: string;
  approval: string;
  status: ApprovalStatus;
  rev: string;
  /** The row's generation (createProposal); a preview refresh keeps it. */
  gen?: string;
  summary: string;
  preview: Array<{ label: string; value: string }>;
  contactId?: string | null;
  priorAttemptSent?: { claimId: string } | null;
  args?: { type?: string; context?: { toStage?: string } };
  live?: {
    deal: { exists: boolean; stageId: string | null; stageLabel: string | null; wouldReplay: boolean };
  };
  reason?: string | null;
  error?: string | null;
  result?: { resultText?: string } | null;
  createdAt: string | null;
  claimedAt: string | null;
}

/** mark_sent / mark_not_sent wait this long after the claim (server's MARK_MIN_AGE_MS). */
export const MARK_WAIT_MS = 60 * 60 * 1000;

export function claimWaitText(claimedAt: string | null, now = Date.now()): string {
  const ready = claimedAt ? new Date(claimedAt).getTime() + MARK_WAIT_MS : now;
  const minutes = Math.max(1, Math.ceil((ready - now) / 60_000));
  return `The action may still be running. You can mark it in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

const MESSAGES: Record<string, string> = {
  stale_proposal: "This request changed since you loaded it. It has been reloaded; review it again.",
  already_decided: "Someone already decided this request.",
  expired: "This request expired before it was approved.",
  key_revoked: "The API key that asked for this was revoked, so the request was rejected.",
  previous_attempt_sent: "An earlier attempt of this exact action already went out.",
  preview_unavailable: "The details for this request can no longer be built.",
  trigger_mismatch: "What triggered this changed since, so nobody was enrolled.",
  // Row reasons (why a row ended rejected).
  rejected_by_approver: "Rejected by a person.",
  not_sent_confirmed: "Marked as not sent.",
};

/** Human text for a stored row reason — never the raw code. */
export function reasonText(code: string | null | undefined): string {
  return (code && MESSAGES[code]) || "This request was closed.";
}

/** Human text for a decide-route refusal. */
export function refusalText(code: string | undefined, row: Pick<ApprovalRow, "claimedAt">, fallback?: string): string {
  if (code === "claim_too_recent") return claimWaitText(row.claimedAt);
  return (code && MESSAGES[code]) || fallback || "That didn't work. Reload and try again.";
}

export const STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: "Waiting for approval",
  executing: "In progress",
  executed: "Done",
  failed: "Failed",
  rejected: "Rejected",
  expired: "Expired",
  unsettled: "Needs checking",
};

/** What each approval class is, for the agency page's row line. */
export const CLASS_LABELS: Record<string, string> = {
  outbound: "Outbound message",
  workflow_activate: "Workflow activation",
  workflow_enrolment: "Workflow enrolment",
  hard_delete: "Permanent delete",
  spend: "Spend",
  channel_change: "Channel change",
  public_change: "Public page change",
  gate_change: "Feature gate",
};
