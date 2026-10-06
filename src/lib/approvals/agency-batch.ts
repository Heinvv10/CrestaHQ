import type { ApprovalRow } from "@/lib/approvals/messages";

/**
 * "Approve all" on /agency/approvals (AGENCY_AGENT_API_PLAN.md D4, REVISED
 * r2 P1-A): only a pending `workflow_activate` or `public_change` row on a
 * target its proposing key created (`keyCreated`, from the list route's
 * `isKeyCreated`) — nothing real is there yet for it to reach. Every other
 * class (`gate_change`, `workflow_enrolment`, `channel_change`, `outbound`,
 * `spend`, `hard_delete`) is approved one row at a time, and so is a row
 * whose earlier attempt already went out. There is no batch endpoint: the
 * loop calls the per-row decide route, so every check and claim holds.
 */

export const BATCH_CLASSES: ReadonlySet<string> = new Set(["workflow_activate", "public_change"]);

/** A row of the agency list route. */
export interface AgencyApprovalRow extends ApprovalRow {
  subAccountId: string | null;
  targetSubAccountId: string;
  targetName: string;
  keyCreated: boolean;
  keyPrefix?: string;
}

export function batchEligible(row: AgencyApprovalRow): boolean {
  return row.status === "pending" && BATCH_CLASSES.has(row.approval) && row.keyCreated === true && !row.priorAttemptSent;
}

/**
 * Approve `rows` one after another through the per-row decide route, each
 * with the `rev` the page shows. A row the server refuses (changed preview,
 * decided meanwhile, switch off …) is left for its own click.
 */
export async function approveAll(
  rows: AgencyApprovalRow[],
  post: (url: string, body: unknown) => Promise<Response> = (url, body) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
): Promise<{ approved: number; refused: number }> {
  let approved = 0;
  for (const row of rows.filter(batchEligible)) {
    const res = await post(`/api/agency/agent-proposals/${row.id}`, { decision: "approve", rev: row.rev });
    if (res.ok) approved++;
  }
  return { approved, refused: rows.filter(batchEligible).length - approved };
}
