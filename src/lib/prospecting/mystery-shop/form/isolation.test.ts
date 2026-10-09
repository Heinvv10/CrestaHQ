import { beforeEach, describe, expect, it, vi } from "vitest";

/** The isolation flag: a canary that reached the host turns the channel off until a later canary passes. */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("./container", () => ({ runCanary: vi.fn() }));
const { mem } = await import("@/test/gbp-sync-store");
const { isolationBlocked, recordIsolation } = await import("./isolation");

let t = 1_000_000_000;
const later = () => (t += 6 * 60_000);
beforeEach(() => mem.clear());

describe("isolationBlocked", () => {
  it("no flag: not blocked, and no canary container is run", async () => {
    const probe = vi.fn(async () => true);
    expect(await isolationBlocked(probe, later())).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("flagged: blocked while the canary still reaches the host; cleared once one passes", async () => {
    await recordIsolation(false);
    expect(await isolationBlocked(async () => false, later())).toBe(true);
    expect(mem.read("system/formEngine")?.unisolatedAt).toBeInstanceOf(Date);
    expect(await isolationBlocked(async () => true, later())).toBe(false);
    expect(mem.read("system/formEngine")).toMatchObject({ unisolatedAt: null, isolatedAt: expect.any(Date) });
  });

  it("the answer is cached for 5 minutes (no container per page view)", async () => {
    await recordIsolation(false);
    const probe = vi.fn(async () => false);
    const at = later();
    await isolationBlocked(probe, at);
    await isolationBlocked(probe, at + 60_000);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
