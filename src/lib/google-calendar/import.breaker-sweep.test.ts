import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The breaker's sweep race on #453 (C1), kept as a regression: the orphan
 * sweep judged a member ineligible, the member opted in and re-imported, and
 * the sweep's delete must not wipe that fresh import.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/google-calendar/provider/select", async () => ({
  getGcalProviderFor: async () => (await import("@/test/gcal-import-harness")).provider,
}));
const hook = vi.hoisted(() => ({ afterActive: null as null | (() => Promise<void>) }));
vi.mock("./connection", async (orig) => {
  const real = await orig<typeof import("./connection")>();
  return {
    ...real,
    isActiveMember: async (sa: string, uid: string) => {
      const r = await real.isActiveMember(sa, uid);
      const h = hook.afterActive;
      if (h) { hook.afterActive = null; await h(); }
      return r;
    },
  };
});
import { mem } from "@/test/gbp-sync-store";
import { CONN, SA, U1, conn, gev, imported, page, provider, resetImport } from "@/test/gcal-import-harness";
import { runCalendarImport } from "./import";
import { setImportMode, sweepOrphanedImports } from "./import-state";

beforeEach(() => {
  resetImport();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("SWEEP-RACE: sweep judged member ineligible, member opts in + re-imports, sweep's unguarded delete wipes the fresh import", async () => {
  // leftover orphan from an earlier failed cleanup; member currently off
  provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
  await runCalendarImport(SA, U1);
  mem.seed(CONN(U1), { ...conn(U1), importMode: "off" });
  expect(imported(U1)).toHaveLength(1);
  hook.afterActive = async () => {
    await setImportMode(SA, U1, "busy");
    expect(await runCalendarImport(SA, U1, { full: true })).toMatchObject({ ok: true });
  };
  await sweepOrphanedImports(Date.now() + 60_000);
  expect(conn(U1).importMode).toBe("busy");
  expect(imported(U1)).toHaveLength(1);
});
