import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/sub-accounts/[id]/reports/stage-history over REAL require-tenancy,
 * the real territory scope and the in-memory Firestore. The fixture below is
 * the reconciliation: every expected number is worked out by hand from the
 * rows, and each excluded row (another sub-account, test mode, import timing,
 * out of range, another pipeline, another territory) is sized so that
 * counting it would change a median.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { AGENCY, OTHER_SA, SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { GET, SCAN_CAP } from "./route";

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const at = (day: number) => new Date(T0 + day * DAY);
/** The range: day 0 to day 10. */
const RANGE = `from=${T0}&to=${T0 + 10 * DAY}`;

let n = 0;
function row(
  dealId: string,
  from: string | null,
  fromDay: number | null,
  to: string,
  day: number,
  more: Record<string, unknown> = {},
) {
  const pipelineId = (more.pipelineId as string) ?? "default";
  mem.seed(`dealStageHistory/h${String(++n).padStart(4, "0")}`, {
    agencyId: AGENCY, subAccountId: SA, createdByUid: "uid_admin", mode: "live", source: "app",
    territoryId: "t_north", assignedToUid: null, dealId, pipelineId, stageId: to,
    fromPipelineId: from === null ? null : pipelineId, fromStageId: from,
    fromStageEnteredAt: fromDay === null ? null : at(fromDay), enteredAt: at(day), ...more,
  });
}

async function read(query = `?${RANGE}`, uid = "uid_collab", sa = SA): Promise<{ status: number; body: Body }> {
  const res = await GET(asUser(`http://127.0.0.1:3100/api/sub-accounts/${sa}/reports/stage-history${query}`, uid), {
    params: Promise.resolve({ id: sa }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const stage = (body: Body, id: string) => body.stages.find((s: Body) => s.stageId === id);

beforeEach(() => {
  n = 0;
  resetSync();
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`), territoryScopingEnabled: true });
  mem.seed(`subAccounts/${SA}/subAccountMembers/uid_collab`, {
    ...mem.read(`subAccounts/${SA}/subAccountMembers/uid_collab`), assignedTerritoryIds: ["t_north"],
  });
  for (const [pid, stages] of [
    ["default", [
      { id: "new", label: "New", tone: "" },
      { id: "qualified", label: "Qualified", tone: "" },
      { id: "proposal", label: "Proposal", tone: "" },
      { id: "won", label: "Won", tone: "", terminal: "won" },
      { id: "lost", label: "Lost", tone: "", terminal: "lost" },
    ]],
    ["p2", [
      { id: "new", label: "New", tone: "" },
      { id: "proposal", label: "Proposal", tone: "" },
      { id: "won", label: "Renewed", tone: "", terminal: "won" }, // same id as the default's won
    ]],
  ] as const) {
    mem.seed(`subAccounts/${SA}/pipelines/${pid}`, {
      name: pid, isDefault: pid === "default", agencyId: AGENCY, subAccountId: SA, stages,
    });
  }

  // d1: new (day 1) -> qualified (3) -> won (6). Stays 2d, 3d; created -> won 5d.
  row("d1", null, null, "new", 1);
  row("d1", "new", 1, "qualified", 3);
  row("d1", "qualified", 3, "won", 6);
  // d2: new (2) -> qualified (6), still in qualified at range end.
  row("d2", null, null, "new", 2);
  row("d2", "new", 2, "qualified", 6);
  // d3 re-enters: new 1 -> qualified 2 -> new 4 -> qualified 5 -> proposal 9.
  row("d3", null, null, "new", 1);
  row("d3", "new", 1, "qualified", 2);
  row("d3", "qualified", 2, "new", 4);
  row("d3", "new", 4, "qualified", 5);
  row("d3", "qualified", 5, "proposal", 9);
  // d4 entered new before the range (day -10): its new stay (12d) still ends in range.
  row("d4", null, null, "new", -10);
  row("d4", "new", -10, "qualified", 2);
  row("d4", "qualified", 2, "lost", 7);
  // d11 is on the shared Global territory, so the collaborator sees it; still in new.
  row("d11", null, null, "new", 8, { territoryId: "global" });
  // d12 predates history: no creation row. proposal stay 12d, won day 7.
  row("d12", "proposal", -5, "won", 7);
  // d13 was created before the range: new stay 7d, created -> won 7d.
  row("d13", null, null, "new", -3);
  row("d13", "new", -3, "won", 4);
  // d14 was created by an import (proposal, day 0): proposal stay 5d, won day 5,
  // but an import creation is not a creation time, so no cycle for velocity.
  row("d14", null, null, "proposal", 0, { source: "import" });
  row("d14", "proposal", 0, "won", 5);
  // d15 starts in proposal (day 1) and moves BACK to new (3): proposal stay 2d;
  // it reached proposal before it entered new, so it has not advanced from new.
  row("d15", null, null, "proposal", 1);
  row("d15", "proposal", 1, "new", 3);
  // d16 / d17 start in p2's "new" and cross into the default pipeline: their
  // stays belong to p2, their entries to the default pipeline.
  row("d16", null, null, "new", 1, { pipelineId: "p2" });
  row("d16", "new", 1, "new", 5, { fromPipelineId: "p2" }); // p2 new 4d
  row("d17", null, null, "new", 2, { pipelineId: "p2" });
  row("d17", "new", 2, "proposal", 6, { fromPipelineId: "p2" }); // p2 new 4d
  // p2: a legacy deal with no recorded stage entry time has no measurable stay.
  row("d19", "new", null, "proposal", 3, { pipelineId: "p2" });
  // d18 advances then falls back: new 7 -> qualified 8 -> new 9. Stays 1d, 1d.
  // It advanced after its first entry into new, so it counts as advanced.
  row("d18", null, null, "new", 7);
  row("d18", "new", 7, "qualified", 8);
  row("d18", "qualified", 8, "new", 9);

  // Rows that must NOT count for the collaborator on the default pipeline:
  row("x_other_sa", "new", -20, "qualified", 10, { subAccountId: OTHER_SA }); // 30d
  row("x_test", "new", -90, "qualified", 10, { mode: "test" }); // 100d
  row("x_out", "new", -38, "qualified", 12); // 50d, entered after the range
  row("x_p2", "new", 1, "won", 2, { pipelineId: "p2" }); // 1d in p2's "new", won in p2 only
  row("x_import", null, null, "new", 2.5); // entered new, then an import moved it on:
  row("x_import", "new", 2.5, "qualified", 3, { source: "import" }); // 0.5d, import timing
  row("x_south", "new", -17, "qualified", 3, { territoryId: "t_south" }); // 20d, other territory
  row("x_untagged", "new", -17, "qualified", 3, { territoryId: null }); // 20d, no territory
});
afterEach(() => vi.restoreAllMocks());

describe("reconciliation (territory-scoped collaborator, default pipeline)", () => {
  it("median time-in-stage counts stays that ended in range, re-entries as separate stays", async () => {
    const { status, body } = await read();
    expect(status).toBe(200);
    // new: d1 2, d2 4, d3 1 + 1, d4 12, d13 7, d18 1 -> [1,1,1,2,4,7,12] -> 2d.
    expect(stage(body, "new")).toMatchObject({ completedStays: 7, medianMs: 2 * DAY });
    // qualified: d1 3, d3 2 + 4, d4 5, d18 1 -> 3d. d2 is still there and is not a stay.
    expect(stage(body, "qualified")).toMatchObject({ completedStays: 5, medianMs: 3 * DAY });
    // proposal: d12 12, d14 5, d15 2 -> 5d.
    expect(stage(body, "proposal")).toMatchObject({ completedStays: 3, medianMs: 5 * DAY });
    expect(stage(body, "won")).toMatchObject({ completedStays: 0, medianMs: null });
  });

  it("entered = distinct deals; still-in = deals whose last row in range put them there", async () => {
    const { body } = await read();
    expect(body.stages.map((s: Body) => [s.stageId, s.entered, s.stillIn])).toEqual([
      ["new", 8, 4], // d1 d2 d3 d11 d15 d16 d18 x_import; d11 d15 d16 d18 still there (an import moved x_import on)
      ["qualified", 5, 1], // d1 d2 d3 d4 d18 (not the import row); d2 still there
      ["proposal", 3, 2], // d3 d15 d17 (not d14's import creation); d3 + d17 still there
      ["won", 4, 4], // d1 d12 d13 d14
      ["lost", 1, 1], // d4
    ]);
  });

  it("conversion: of deals that entered a stage, how many later reached a stage further along", async () => {
    const { body } = await read();
    expect(body.stages.map((s: Body) => [s.stageId, s.advanced])).toEqual([
      ["new", 4], // d1 d2 d3 d18; d11 did not move, d15 was further along BEFORE, x_import moved by import
      ["qualified", 2], // d1 (won), d3 (proposal); d2 stayed, d4 went to lost, d18 went back
      ["proposal", 0],
      ["won", null], // last stage of the funnel
      ["lost", null], // lost is not a funnel step
    ]);
  });

  it("velocity: creation -> won, reading creation rows from before the range", async () => {
    const { body } = await read();
    // d1 5d, d13 7d (created day -3); d12 has no creation row, d14's is an import.
    expect(body.velocity).toEqual({ won: 4, withCreation: 2, medianMs: 6 * DAY });
    expect(body.truncated).toBe(false);
  });
});

describe("scope", () => {
  it("an admin also sees rows from other territories and untagged deals", async () => {
    const { body } = await read(`?${RANGE}`, "uid_admin");
    // new gains x_south 20d and x_untagged 20d: [1,1,1,2,4,7,12,20,20] -> 4d.
    expect(stage(body, "new")).toMatchObject({ completedStays: 9, medianMs: 4 * DAY });
  });

  it("another pipeline reports its own rows only", async () => {
    const { body } = await read(`?pipelineId=p2&${RANGE}`);
    // x_p2 1d, d16 4d, d17 4d. d16 and d17 left for the default pipeline: not still
    // in p2's "new", and d17 reaching the DEFAULT pipeline's proposal is no advance.
    expect(stage(body, "new")).toMatchObject({
      completedStays: 3, medianMs: 4 * DAY, entered: 2, stillIn: 0, advanced: 0,
    });
    expect(body.velocity).toEqual({ won: 1, withCreation: 0, medianMs: null });
  });

  it("an empty range is an honest empty report", async () => {
    const { body } = await read(`?from=${T0 + 100 * DAY}&to=${T0 + 101 * DAY}`);
    expect(body.rowsRead).toBe(0);
    expect(body.stages.every((s: Body) => s.entered === 0 && s.medianMs === null)).toBe(true);
  });

  it("flags a partial report past the scan cap", async () => {
    for (let i = 0; i <= SCAN_CAP; i++) row(`bulk${i}`, null, null, "new", 1);
    const { body } = await read();
    expect(body.truncated).toBe(true);
  });
});

describe("authorization and validation", () => {
  it.each([
    ["a signed-in non-member", "uid_stranger"],
    ["an admin of ANOTHER sub-account", "uid_other_admin"],
  ])("refuses %s", async (_l, uid) => {
    expect((await read(`?${RANGE}`, uid)).status).toBe(403);
  });

  it.each([
    ["no from", `?to=${T0}`],
    ["no to", `?from=${T0}`],
    ["to before from", `?from=${T0}&to=${T0 - 1}`],
    ["a bad pipeline id", `?pipelineId=../x&${RANGE}`],
  ])("refuses %s", async (_l, q) => {
    expect((await read(q)).status).toBe(400);
  });

  it("404s an unknown pipeline", async () => {
    expect((await read(`?pipelineId=nope&${RANGE}`)).status).toBe(404);
  });
});
