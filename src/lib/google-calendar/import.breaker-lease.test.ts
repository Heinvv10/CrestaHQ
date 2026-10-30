import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The breaker's second round on #453 (C1), kept as regressions: the
 * per-member lease (one walk for concurrent claimers, expired takeover, a
 * late release never frees another pass's lease, a stuck lease never blocks
 * a cleanup) and the orphan sweep's cursor (every doc covered, eligible docs
 * kept, docs behind the cursor reached after the wrap).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/google-calendar/provider/select", async () => ({
  getGcalProviderFor: async () => (await import("@/test/gcal-import-harness")).provider,
}));

import { mem } from "@/test/gbp-sync-store";
import { CONN, SA, U1, conn, gev, imported, page, provider, resetImport } from "@/test/gcal-import-harness";
import { runCalendarImport } from "./import";
import { setImportMode, sweepOrphanedImports, SWEEP_CURSOR_PATH } from "./import-state";

const defer = <T,>() => { let res!: (v: T) => void; const p = new Promise<T>((r) => (res = r)); return { p, res }; };
const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  resetImport();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("lease", () => {
  it("L1: two concurrent claimers -> exactly one Google walk", async () => {
    const d = defer<ReturnType<typeof page>>();
    provider.syncEvents.mockImplementation(() => d.p);
    const a = runCalendarImport(SA, U1);
    const b = runCalendarImport(SA, U1);
    await tick();
    d.res(page([gev("g1", 2, 3)]));
    const [ra, rb] = await Promise.all([a, b]);
    expect(provider.syncEvents).toHaveBeenCalledTimes(1);
    expect([ra.skipped, rb.skipped].filter(Boolean)).toEqual(["in_progress"]);
    expect(conn(U1).importLeaseId ?? null).toBeNull();
  });

  it("L2: expired takeover; the first holder's late release must not free the second's lease", async () => {
    const dA = defer<ReturnType<typeof page>>();
    const dB = defer<ReturnType<typeof page>>();
    provider.syncEvents.mockImplementationOnce(() => dA.p).mockImplementationOnce(() => dB.p);
    const a = runCalendarImport(SA, U1);
    await tick();
    const leaseA = conn(U1).importLeaseId;
    mem.seed(CONN(U1), { ...conn(U1), importLeaseUntil: new Date(Date.now() - 1000) }); // A's lease lapses
    const b = runCalendarImport(SA, U1);
    await tick();
    const leaseB = conn(U1).importLeaseId;
    expect(leaseB).not.toBe(leaseA);
    dA.res(page([gev("g1", 2, 3)]));
    await a;
    expect(conn(U1).importLeaseId).toBe(leaseB); // still B's
    const c = await runCalendarImport(SA, U1);
    expect(c.skipped).toBe("in_progress");
    dB.res(page([gev("g1", 2, 3)]));
    await b;
    expect(conn(U1).importLeaseId ?? null).toBeNull();
  });

  it("L3: a crashed holder blocks passes but never blocks opt-out / details->busy strip / revoke deletes", async () => {
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
    mem.seed(CONN(U1), { ...conn(U1), importMode: "details" });
    await runCalendarImport(SA, U1);
    expect(imported(U1)[0].title).toBe("Dentist");
    // crash: lease held for 5 min
    mem.seed(CONN(U1), { ...conn(U1), importLeaseId: "dead", importLeaseUntil: new Date(Date.now() + 300_000), importLastFullAttemptAt: new Date() });
    await setImportMode(SA, U1, "busy");
    expect(imported(U1)[0].title).toBe("Busy");
    expect(imported(U1)[0].location).toBe("");
    // revoke while lease held + inside cooldown
    mem.seed(CONN(U1), { ...conn(U1), status: "revoked" });
    const r = await runCalendarImport(SA, U1, { full: true, minFullIntervalMs: 60_000 });
    expect(r.skipped).toBe("not_eligible");
    expect(imported(U1)).toHaveLength(0);
  });

  it("L4: opt-out then opt-in inside cooldown never leaves old data; lease held makes the new pass skip", async () => {
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
    await runCalendarImport(SA, U1, { full: true, minFullIntervalMs: 60_000 });
    await setImportMode(SA, U1, "off");
    expect(imported(U1)).toHaveLength(0);
    await setImportMode(SA, U1, "busy");
    const r = await runCalendarImport(SA, U1, { full: true, minFullIntervalMs: 60_000 });
    expect(r.skipped).toBe("cooldown");
    // token was cleared by setImportMode so the next scheduled pass is full
    const next = await runCalendarImport(SA, U1);
    expect(next.full).toBe(true);
    expect(imported(U1)).toHaveLength(1);
  });

  it("L5: pass that discovers revoked grant mid-walk deletes (no livelock, no stuck lease)", async () => {
    provider.syncEvents.mockResolvedValueOnce(page([gev("g1", 2, 3)]));
    await runCalendarImport(SA, U1);
    provider.syncEvents.mockImplementationOnce(async () => {
      mem.seed(CONN(U1), { ...conn(U1), status: "revoked" });
      throw new Error("boom");
    });
    const r = await runCalendarImport(SA, U1, { full: true });
    expect(r.ok).toBe(false);
    expect(imported(U1)).toHaveLength(0);
    expect(conn(U1).importLeaseId ?? null).toBeNull();
  });
});

describe("sweep cursor", () => {
  it("S1: repeated one-page sweeps cover every doc exactly once and never delete eligible docs", async () => {
    provider.syncEvents.mockResolvedValue(page(Array.from({ length: 30 }, (_, i) => gev(`g${i}`, 2 + i, 2.5 + i))));
    await runCalendarImport(SA, U1);
    expect(imported(U1)).toHaveLength(30);
    for (let i = 0; i < 1000; i++) {
      mem.seed(`events/gcal_orphan_${String(i).padStart(4, "0")}`, { source: "google", subAccountId: SA, importOwnerUid: "ghost" });
    }
    const real = Date.now.bind(Date);
    let runs = 0;
    for (; runs < 20 && imported().some((e) => e.importOwnerUid === "ghost"); runs++) {
      let n = 0;
      const spy = vi.spyOn(Date, "now").mockImplementation(() => (n++ === 0 ? real() : real() + 1e9));
      await sweepOrphanedImports(real() + 60_000);
      spy.mockRestore();
    }
    expect(imported().filter((e) => e.importOwnerUid === "ghost")).toHaveLength(0);
    expect(imported(U1)).toHaveLength(30);
    // One owner: the first page's guarded delete takes all 1,000 of theirs.
    expect(runs).toBe(1);
  });

  it("S2: orphans inserted BEHIND the cursor wait for a full wrap", async () => {
    mem.seed(SWEEP_CURSOR_PATH, { cursor: "gcal_zzzz" });
    mem.seed(`events/gcal_aaaa`, { source: "google", subAccountId: SA, importOwnerUid: "ghost" });
    await sweepOrphanedImports(Date.now() + 60_000);
    // started after cursor -> nothing after -> reached end; aaaa not examined this run
    expect(imported().filter((e) => e.importOwnerUid === "ghost")).toHaveLength(1);
    await sweepOrphanedImports(Date.now() + 60_000);
    expect(imported().filter((e) => e.importOwnerUid === "ghost")).toHaveLength(0);
  });
});
