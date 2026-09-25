import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * runId() is what makes a spec's purge scope to its own run instead of
 * sweeping a concurrent run's docs (see run-id.ts). A stale, empty, or
 * process-unstable id would silently reopen that collision.
 */
describe("runId", () => {
  const originalRunId = process.env.GITHUB_RUN_ID;
  const originalAttempt = process.env.GITHUB_RUN_ATTEMPT;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalRunId === undefined) delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID = originalRunId;
    if (originalAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = originalAttempt;
  });

  it("is stable within a process", async () => {
    delete process.env.GITHUB_RUN_ID;
    const { runId } = await import("./run-id");
    expect(runId()).toBe(runId());
  });

  it("is never empty, with or without GITHUB_RUN_ID", async () => {
    delete process.env.GITHUB_RUN_ID;
    const { runId: runIdLocal } = await import("./run-id");
    expect(runIdLocal().length).toBeGreaterThan(0);

    vi.resetModules();
    process.env.GITHUB_RUN_ID = "123456";
    const { runId: runIdCi } = await import("./run-id");
    expect(runIdCi().length).toBeGreaterThan(0);
  });

  it("differs across GITHUB_RUN_ID values", async () => {
    process.env.GITHUB_RUN_ID = "111";
    process.env.GITHUB_RUN_ATTEMPT = "1";
    const { runId: runIdA } = await import("./run-id");
    const a = runIdA();

    vi.resetModules();
    process.env.GITHUB_RUN_ID = "222";
    process.env.GITHUB_RUN_ATTEMPT = "1";
    const { runId: runIdB } = await import("./run-id");
    const b = runIdB();

    expect(a).not.toBe(b);
  });

  it("differs across GITHUB_RUN_ATTEMPT values for the same run id (re-runs)", async () => {
    process.env.GITHUB_RUN_ID = "111";
    process.env.GITHUB_RUN_ATTEMPT = "1";
    const { runId: runIdAttempt1 } = await import("./run-id");
    const a = runIdAttempt1();

    vi.resetModules();
    process.env.GITHUB_RUN_ID = "111";
    process.env.GITHUB_RUN_ATTEMPT = "2";
    const { runId: runIdAttempt2 } = await import("./run-id");
    const b = runIdAttempt2();

    expect(a).not.toBe(b);
  });

  it("uses GITHUB_RUN_ID verbatim when present", async () => {
    process.env.GITHUB_RUN_ID = "999888";
    process.env.GITHUB_RUN_ATTEMPT = "1";
    const { runId } = await import("./run-id");
    expect(runId()).toBe("999888-1");
  });
});
