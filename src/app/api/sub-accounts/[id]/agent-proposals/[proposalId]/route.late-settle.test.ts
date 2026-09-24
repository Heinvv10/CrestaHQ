import { describe, expect, it, vi } from "vitest";
import { CapabilityUserError } from "@/lib/ai-suite/capabilities";
import {
  ageClaim, approveHangingThenUnsettle, decide, execute, hangNextExecute, history, mem, propose,
  proposeId, row, setupAgentProposalTests,
} from "@/test/agent-proposals-harness";

/**
 * Late settles: an approve whose execute outlives its claim. Whatever order
 * the real outcome, the sweep and a person's mark_* arrive in, the action
 * must run once and the row must end on the real outcome where it is known.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => undefined);
const flush = async (until: () => boolean) => {
  for (let i = 0; i < 500 && !until(); i++) await new Promise((r) => setImmediate(r));
};

describe("the claim's own late settle", () => {
  it("resolves the unsettled row to its real outcome; mark_* then 409 (breaker R3)", async () => {
    const id = await proposeId();
    const staleRev = row(id).rev;
    const a = await approveHangingThenUnsettle(id);
    a.finish();
    await a.approving;
    expect(row(id)).toMatchObject({ status: "executed", settledLate: true, result: { resultText: "sent" } });
    expect(history(id)).toEqual([]);
    await ageClaim(id);
    expect(await (await decide(id, "mark_not_sent")).json()).toEqual({ error: "already_decided" });
    await proposeId();
    expect((await decide(id, "approve", "sa1", staleRev)).status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mem.list("aiSuiteActions")).toHaveLength(1);
  });

  it("overrides a person's mark_not_sent with the executed outcome (settledLate, overrodeHuman)", async () => {
    const id = await proposeId();
    const a = await approveHangingThenUnsettle(id);
    await ageClaim(id);
    expect((await decide(id, "mark_not_sent")).status).toBe(200);
    a.finish();
    await a.approving;
    expect(row(id)).toMatchObject({ status: "executed", settledLate: true, overrodeHuman: true });
  });

  it("F7: overrides a person's mark_sent with the failed outcome", async () => {
    const id = await proposeId();
    const a = await approveHangingThenUnsettle(id);
    await ageClaim(id);
    expect((await decide(id, "mark_sent")).status).toBe(200);
    a.fail(new CapabilityUserError("The recipient's number is invalid."));
    await a.approving;
    expect(row(id)).toMatchObject({ status: "failed", settledLate: true, overrodeHuman: true, error: "The recipient's number is invalid." });
  });

  it("an executed settle after a person's mark_sent still replaces the guess with the real outcome", async () => {
    const id = await proposeId();
    const a = await approveHangingThenUnsettle(id);
    await ageClaim(id);
    expect((await decide(id, "mark_sent")).status).toBe(200);
    a.finish();
    await a.approving;
    expect(row(id)).toMatchObject({ status: "executed", settledLate: true, overrodeHuman: true, result: { resultText: "sent" } });
    expect(history(id)).toEqual([]);
  });

  it("a failed settle after a person's mark_not_sent resolves the row to failed (any late settle wins)", async () => {
    const id = await proposeId();
    const a = await approveHangingThenUnsettle(id);
    await ageClaim(id);
    expect((await decide(id, "mark_not_sent")).status).toBe(200);
    a.fail(new CapabilityUserError("Provider refused the message."));
    await a.approving;
    expect(row(id)).toMatchObject({ status: "failed", settledLate: true, overrodeHuman: true, error: "Provider refused the message." });
  });
});

describe("a late settle after the row moved to a new generation", () => {
  async function reproposedWhileInFlight() {
    const id = await proposeId();
    const a = await approveHangingThenUnsettle(id);
    await ageClaim(id);
    expect((await decide(id, "mark_not_sent")).status).toBe(200);
    await proposeId();
    expect(row(id).status).toBe("pending");
    return { id, a };
  }

  it("F6: an executed settle rejects the new pending generation in the same transaction — even with a skewed clock", async () => {
    const { id, a } = await reproposedWhileInFlight();
    quiet();
    // The settling process's clock runs an hour behind the one that wrote the row.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 3_600_000 });
    a.finish();
    await a.approving;
    vi.useRealTimers();
    expect(row(id)).toMatchObject({ status: "rejected", reason: "previous_attempt_sent" });
    expect(history(id)).toContainEqual(expect.objectContaining({ lateSettle: true, status: "executed" }));
    expect((await decide(id, "approve")).status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("a failed late settle leaves the new generation approvable", async () => {
    const { id, a } = await reproposedWhileInFlight();
    quiet();
    a.fail(new CapabilityUserError("Provider refused the message."));
    await a.approving;
    expect(row(id).status).toBe("pending");
    expect((await decide(id, "approve")).status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("M1: A's late settle after B claimed the new generation → history; B's claim untouched", async () => {
    const { id, a } = await reproposedWhileInFlight();
    const b = hangNextExecute();
    const approvingB = decide(id, "approve");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    const bClaim = row(id).claimId;
    quiet();
    a.finish();
    await a.approving;
    expect(row(id)).toMatchObject({ status: "executing", claimId: bClaim });
    expect(history(id)).toContainEqual(expect.objectContaining({ lateSettle: true, status: "executed" }));
    b.finish();
    await approvingB;
    expect(row(id).status).toBe("executed");
  });
});

describe("F5: an execute that may still be running", () => {
  it("mark_not_sent right after the sweep → 409 claim_too_recent; the action runs once", async () => {
    const id = await proposeId();
    const a = await approveHangingThenUnsettle(id);
    expect(await (await decide(id, "mark_not_sent")).json()).toEqual({ error: "claim_too_recent" });
    expect(await (await decide(id, "mark_sent")).json()).toEqual({ error: "claim_too_recent" });
    expect(await propose()).toMatchObject({ code: "outcome_unknown" });
    a.finish();
    await a.approving;
    expect(row(id)).toMatchObject({ status: "executed", settledLate: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("past EXECUTE_DEADLINE_MS the approve flips its own claim to unsettled → 202, aborts ctx.signal", async () => {
    const { EXECUTE_DEADLINE_MS, STALE_CLAIM_MS } = await import("@/lib/server/agent-proposals");
    expect(EXECUTE_DEADLINE_MS).toBeLessThan(STALE_CLAIM_MS);
    const id = await proposeId();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const a = hangNextExecute();
    const approving = decide(id, "approve");
    await flush(() => execute.mock.calls.length > 0);
    const signal = execute.mock.calls[0]![0].signal!;
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(EXECUTE_DEADLINE_MS);
    const res = await approving;
    vi.useRealTimers();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "unsettled" });
    expect(row(id).status).toBe("unsettled");
    expect(signal.aborted).toBe(true);
    a.finish();
    await flush(() => row(id).status !== "unsettled");
    expect(row(id)).toMatchObject({ status: "executed", settledLate: true });
  });
});
