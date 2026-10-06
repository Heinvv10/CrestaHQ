import { describe, expect, it, vi } from "vitest";
import { approveAll, batchEligible, type AgencyApprovalRow } from "./agency-batch";

/**
 * The agency page's "Approve all" set: only pending workflow_activate /
 * public_change rows on a target the proposing key created, never a row
 * whose earlier attempt went out; approved one at a time through the
 * per-row decide route, never a batch endpoint.
 */

const row = (over: Partial<AgencyApprovalRow> = {}): AgencyApprovalRow => ({
  id: "p1", capability: "set_workflow_status", approval: "workflow_activate", status: "pending", rev: "r1",
  summary: "s", preview: [], createdAt: null, claimedAt: null,
  subAccountId: "sa1", targetSubAccountId: "sa1", targetName: "One", keyCreated: true,
  ...over,
});

describe("batchEligible", () => {
  it.each(["workflow_activate", "public_change"])("%s on a key-created target → yes", (approval) => {
    expect(batchEligible(row({ approval }))).toBe(true);
  });

  it.each(["gate_change", "workflow_enrolment", "channel_change", "outbound", "spend", "hard_delete"])(
    "%s → never, even on a key-created target",
    (approval) => expect(batchEligible(row({ approval }))).toBe(false)
  );

  it("not key-created, not pending, or a prior attempt went out → no", () => {
    expect(batchEligible(row({ keyCreated: false }))).toBe(false);
    expect(batchEligible(row({ status: "unsettled" }))).toBe(false);
    expect(batchEligible(row({ priorAttemptSent: { claimId: "c0" } }))).toBe(false);
  });
});

describe("approveAll", () => {
  it("posts each eligible row in turn, with its rev, and counts what the server refused", async () => {
    const calls: Array<[string, unknown]> = [];
    let inFlight = 0;
    const post = vi.fn(async (url: string, body: unknown) => {
      inFlight++;
      expect(inFlight).toBe(1);
      calls.push([url, body]);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return new Response("{}", { status: url.endsWith("/a2") ? 409 : 200 });
    });
    const rows = [
      row({ id: "a1", rev: "ra1" }),
      row({ id: "g1", approval: "gate_change" }),
      row({ id: "a2", rev: "ra2", approval: "public_change" }),
      row({ id: "n1", keyCreated: false }),
    ];
    expect(await approveAll(rows, post)).toEqual({ approved: 1, refused: 1 });
    expect(calls).toEqual([
      ["/api/agency/agent-proposals/a1", { decision: "approve", rev: "ra1" }],
      ["/api/agency/agent-proposals/a2", { decision: "approve", rev: "ra2" }],
    ]);
  });
});
