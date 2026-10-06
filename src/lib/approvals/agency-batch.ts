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
 * Approve the eligible `rows` the page shows, one after another through the
 * per-row decide route, each with the `rev` and `gen` the page shows. The
 * open queue is re-read first and eligibility recomputed on it: a row that
 * stopped being eligible (or left the queue) since the page loaded is
 * skipped, and a row the page never showed is never approved. Only a 200
 * counts as approved; a 202 is `unsettled` (outcome not known yet); a row the
 * server refuses (changed preview, decided meanwhile, switch off …) is left
 * for its own click.
 */
export async function approveAll(
  rows: AgencyApprovalRow[],
  http: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)
): Promise<{ approved: number; unsettled: number; refused: number }> {
  const seen = rows.filter(batchEligible);
  const res = await http("/api/agency/agent-proposals?status=open");
  if (!res.ok) throw new Error("Couldn't reload approvals.");
  const { proposals = [] } = (await res.json()) as { proposals?: AgencyApprovalRow[] };
  const stillEligible = new Set(proposals.filter(batchEligible).map((r) => r.id));
  let approved = 0;
  let unsettled = 0;
  for (const row of seen.filter((r) => stillEligible.has(r.id))) {
    const body = { decision: "approve", rev: row.rev, ...(row.gen ? { gen: row.gen } : {}) };
    const decided = await http(`/api/agency/agent-proposals/${row.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (decided.status === 200) approved++;
    else if (decided.status === 202) unsettled++;
  }
  return { approved, unsettled, refused: seen.length - approved - unsettled };
}
