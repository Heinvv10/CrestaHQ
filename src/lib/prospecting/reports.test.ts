import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * failAndRelease — the only path that gives quota back. Its callers (publish
 * failure, the worker) are tested at their routes; here, the guard that stops
 * a repeat call on a settled report from releasing twice.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const { failAndRelease } = await import("./reports");

const USAGE = "subAccounts/sa1/usage/2026-09";

beforeEach(() => {
  mem.clear();
  mem.seed(USAGE, { prospectReports: 3 });
  mem.seed("prospectReports/r1", { subAccountId: "sa1", status: "running", usageMonth: "2026-09" });
});

describe("failAndRelease", () => {
  it("releases once: a second call on the now-failed report changes nothing", async () => {
    expect(await failAndRelease("r1")).toBe(true);
    expect(await failAndRelease("r1")).toBe(false);
    expect(mem.read(USAGE)?.prospectReports).toBe(2);
  });

  it("never releases a ready report, and floors the counter at 0", async () => {
    mem.seed("prospectReports/r1", { subAccountId: "sa1", status: "ready", usageMonth: "2026-09" });
    expect(await failAndRelease("r1")).toBe(false);
    expect(mem.read("prospectReports/r1")?.status).toBe("ready");
    mem.seed("prospectReports/r2", { subAccountId: "sa1", status: "queued", usageMonth: "2026-09" });
    mem.seed(USAGE, { prospectReports: 0 });
    expect(await failAndRelease("r2")).toBe(true);
    expect(mem.read(USAGE)?.prospectReports).toBe(0);
  });
});
