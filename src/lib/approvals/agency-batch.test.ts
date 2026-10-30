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

  it("an apply_snapshot row → never, though public_change on a key-created target (owner ruling 2026-10-06)", () => {
    expect(batchEligible(row({ approval: "public_change", capability: "apply_snapshot" }))).toBe(false);
    expect(batchEligible(row({ approval: "public_change", capability: "update_booking_page" }))).toBe(true);
  });

  it("not key-created, not pending, or a prior attempt went out → no", () => {
    expect(batchEligible(row({ keyCreated: false }))).toBe(false);
    expect(batchEligible(row({ status: "unsettled" }))).toBe(false);
    expect(batchEligible(row({ priorAttemptSent: { claimId: "c0" } }))).toBe(false);
  });
});

/** The server side of approveAll: `?status=open` answers `open`; each POST answers `decide(id)`. */
function server(open: AgencyApprovalRow[], decide: (id: string) => number = () => 200) {
  const posts: Array<[string, unknown]> = [];
  let inFlight = 0;
  const http = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== "POST") {
      expect(url).toBe("/api/agency/agent-proposals?status=open");
      return new Response(JSON.stringify({ proposals: open }));
    }
    inFlight++;
    expect(inFlight).toBe(1);
    posts.push([url, JSON.parse(String(init.body))]);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    const status = decide(url.split("/").pop()!);
    const body = status === 200 ? { status: "executed" } : status === 202 ? { status: "unsettled" } : { error: "stale_proposal" };
    return new Response(JSON.stringify(body), { status });
  });
  return { http, posts };
}

describe("approveAll", () => {
  it("posts each eligible row in turn, with the rev and gen the page shows, and counts what the server refused", async () => {
    const rows = [
      row({ id: "a1", rev: "ra1", gen: "ga1" }),
      row({ id: "g1", approval: "gate_change" }),
      row({ id: "a2", rev: "ra2", approval: "public_change" }),
      row({ id: "n1", keyCreated: false }),
    ];
    const { http, posts } = server(rows, (id) => (id === "a2" ? 409 : 200));
    expect(await approveAll(rows, http)).toEqual({ approved: 1, unsettled: 0, refused: 1 });
    expect(posts).toEqual([
      ["/api/agency/agent-proposals/a1", { decision: "approve", rev: "ra1", gen: "ga1" }],
      ["/api/agency/agent-proposals/a2", { decision: "approve", rev: "ra2" }],
    ]);
  });

  it("a 202 (outcome not known yet) is counted as unsettled, never as approved", async () => {
    const rows = [row({ id: "a1" }), row({ id: "a2" })];
    const { http } = server(rows, (id) => (id === "a1" ? 202 : 200));
    expect(await approveAll(rows, http)).toEqual({ approved: 1, unsettled: 1, refused: 0 });
  });

  it("re-reads the queue first: a row no longer eligible is skipped, a row the page never showed is not approved", async () => {
    const seen = [row({ id: "a1" }), row({ id: "a2" }), row({ id: "a3" })];
    const now = [
      row({ id: "a1" }),
      row({ id: "a2", keyCreated: false }), // its target has a person's edit by now
      // a3 was decided meanwhile: gone from the open set
      row({ id: "new" }), // eligible, but the person never saw it
    ];
    const { http, posts } = server(now);
    expect(await approveAll(seen, http)).toEqual({ approved: 1, unsettled: 0, refused: 2 });
    expect(posts.map(([url]) => url)).toEqual(["/api/agency/agent-proposals/a1"]);
  });

  it("the queue cannot be re-read → throws before approving anything", async () => {
    const http = vi.fn(async () => new Response("{}", { status: 500 }));
    await expect(approveAll([row()], http)).rejects.toThrow();
    expect(http).toHaveBeenCalledTimes(1);
  });
});
