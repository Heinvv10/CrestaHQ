import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The breaker's repros from the review of #453 (C1), kept as regressions:
 * reconnect ABA, a stale "not eligible" pass, an empty uid, the admin
 * switching off between the route's check and the write, a revoked grant,
 * and an all-day event in a +13 zone.
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
import { CONN, SA, U1, U2, conn, connectMember, gev, imported, page, provider, resetImport } from "@/test/gcal-import-harness";
import { runCalendarImport } from "./import";
import { ImportModeRefusedError, deleteImportedEvents, setImportMode } from "./import-state";

beforeEach(() => {
  resetImport();
  connectMember(U2);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("brk453", () => {
  it("REPRO 1: reconnect to another Google account + re-opt-in mid-pass lets the OLD account's walk commit", async () => {
    // member opted in on account A (mode busy, gen 1). A pass starts, walks A's calendar.
    provider.syncEvents.mockImplementationOnce(async () => {
      // while Google is slow: member disconnects, reconnects as account B (callback does a whole-doc set,
      // no import fields), then opts in again via PATCH mode.
      await mem.db.doc(CONN(U1)).delete();
      mem.seed(CONN(U1), {
        uid: U1, agencyId: "ag_1", subAccountId: SA, googleEmail: "accountB@example.com",
        refreshToken: "r-b", accessToken: "a-b", accessTokenExpiresAt: Date.now() + 3_600_000,
        // A reconnect is later than the connection it replaces.
        scopes: [], status: "connected", connectedAt: new Date(Date.now() + 1_000), lastError: null, lastErrorAt: null,
      });
      await setImportMode(SA, U1, "busy");
      return page([gev("accountA-secret", 2, 3)], { nextSyncToken: "tok-ACCOUNT-A" });
    });
    const r = await runCalendarImport(SA, U1);
    // Expect: old walk refused (settings_changed), nothing from account A stored on B's connection.
    expect(imported(U1).map((e) => e.id)).toEqual([]);
    expect(conn(U1).importSyncToken ?? null).not.toBe("tok-ACCOUNT-A");
    expect(r.skipped).toBe("settings_changed");
  });

  it("REPRO 2: a stale 'not eligible' pass wipes the imports a fresh opt-in just wrote", async () => {
    mem.seed(CONN(U1), { ...conn(U1), importMode: "off" });
    // Pass P1 (cron) reads state while the member is opted out...
    hook.afterActive = async () => {
      // ...then member opts in and P2 (the immediate full import) completes.
      await setImportMode(SA, U1, "busy");
      provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3), gev("g2", 4, 5)], { nextSyncToken: "tok-2" }));
      expect(await runCalendarImport(SA, U1, { full: true })).toMatchObject({ ok: true, written: 2 });
    };
    await runCalendarImport(SA, U1); // P1 -> not_eligible -> deleteImportedEvents
    // opted in + synced, token stored => imports must still be there
    expect(conn(U1).importMode).toBe("busy");
    expect(imported(U1)).toHaveLength(2);
  });

  it("REPRO 3: deleteImportedEvents with an empty uid wipes the whole workspace", async () => {
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
    await runCalendarImport(SA, U1);
    await runCalendarImport(SA, U2);
    expect(imported()).toHaveLength(2);
    await expect(deleteImportedEvents(SA, "")).rejects.toThrow(/empty uid/);
    expect(imported(U2)).toHaveLength(1);
    expect(imported(U1)).toHaveLength(1);
  });

  it("REPRO 4: admin turns workspace import off between member PATCH check and setImportMode -> opt-in survives", async () => {
    const { setWorkspaceImportAllowed } = await import("./import-state");
    mem.seed(CONN(U1), { ...conn(U1), importMode: "off" });
    // PATCH mode route: checks calendarImportAllowed (true) ... then admin switches off ... then setImportMode runs.
    await setWorkspaceImportAllowed(SA, false);
    await expect(setImportMode(SA, U1, "details")).rejects.toBeInstanceOf(ImportModeRefusedError);
    await setWorkspaceImportAllowed(SA, true);
    expect(conn(U1).importMode).toBe("off");
  });

  it("REPRO 5: Google access revoked (status != connected) leaves imported titles on the calendar indefinitely", async () => {
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
    await runCalendarImport(SA, U1);
    mem.seed(CONN(U1), { ...conn(U1), status: "revoked" });
    expect(await runCalendarImport(SA, U1)).toMatchObject({ skipped: "not_eligible", deleted: 1 });
    expect(imported(U1)).toHaveLength(0);
  });

  it("REPRO 6: all-day Busy event in a +13 zone", async () => {
    // Pinned clock: the event must sit inside the import window whenever this runs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-15T00:00:00Z"));
    resetImport();
    provider.syncEvents.mockResolvedValue(page([{ id: "ad", status: "confirmed", start: { date: "2027-02-02" }, end: { date: "2027-02-03" } }], { timeZone: "Pacific/Auckland" }));
    await runCalendarImport(SA, U1, { full: true });
    const d = imported(U1)[0] as { startAt?: { toDate?: () => Date }; endAt?: { toDate?: () => Date } } | undefined;
    expect(d?.startAt?.toDate?.().toISOString() ?? d?.startAt).toBe("2027-02-01T11:00:00.000Z");
    expect(d?.endAt?.toDate?.().toISOString() ?? d?.endAt).toBe("2027-02-02T11:00:00.000Z");
  });
});
