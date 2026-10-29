import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The three keys behind imported Google events — agency gate, workspace
 * allowance, member opt-in — over the in-memory Firestore: any key off means
 * no Google call and nothing of that member's calendar left, including when
 * the key flips WHILE a pass is reading Google (the cleanup must win).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/google-calendar/provider/select", async () => ({
  getGcalProviderFor: async () => (await import("@/test/gcal-import-harness")).provider,
}));
vi.mock("@/lib/gbp/sync/clear", () => ({ clearAllGbpCaches: async () => undefined }));
vi.mock("@/lib/comms/resend-domains", () => ({ removeSendingDomain: async () => undefined }));

import { mem } from "@/test/gbp-sync-store";
import { AG, CONN, SA, U1, U2, conn, connectMember, gev, imported, page, provider, resetImport } from "@/test/gcal-import-harness";
import { applyFeatureGates } from "@/lib/server/feature-gates-service";
import { runCalendarImport } from "./import";
import {
  SWEEP_CURSOR_PATH,
  listImportTargets,
  setImportMode,
  setWorkspaceImportAllowed,
  sweepOrphanedImports,
} from "./import-state";

beforeEach(() => {
  resetImport();
  connectMember(U2);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Both members imported one event each. */
async function seedImports() {
  provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
  await runCalendarImport(SA, U1);
  await runCalendarImport(SA, U2);
  expect(imported()).toHaveLength(2);
  provider.syncEvents.mockClear();
}

describe("any key off: no Google call, and the member's imports are removed", () => {
  it.each([
    ["the agency gate is off", () => mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`), googleCalendarEnabledByAgency: false })],
    ["the workspace allowance is off", () => mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`), calendarImportAllowed: false })],
    ["the member opted out", () => mem.seed(CONN(U1), { ...conn(U1), importMode: "off" })],
    ["the member never opted in", () => mem.seed(CONN(U1), { ...conn(U1), importMode: undefined })],
    ["the member disconnected", () => mem.db.doc(CONN(U1)).delete()],
    ["the member was removed", () => mem.seed(`subAccounts/${SA}/subAccountMembers/${U1}`, { uid: U1, status: "removed" })],
  ])("%s", async (_name, flip) => {
    await seedImports();
    await flip();
    expect(await runCalendarImport(SA, U1)).toMatchObject({ ok: true, skipped: "not_eligible", deleted: 1 });
    expect(provider.syncEvents).not.toHaveBeenCalled();
    expect(imported(U1)).toEqual([]);
    expect(imported(U2)).toHaveLength(1);
  });
});

describe("the switches", () => {
  it("opting out removes only the caller's imports, at once", async () => {
    await seedImports();
    expect(await setImportMode(SA, U1, "off")).toBe(1);
    expect(imported(U1)).toEqual([]);
    expect(imported(U2)).toHaveLength(1);
    expect(conn(U1)).toMatchObject({ importMode: "off", importGeneration: 2, importSyncToken: null, importedCount: 0 });
  });

  it("details → busy strips titles and places at once, before any sync", async () => {
    mem.seed(CONN(U1), { ...conn(U1), importMode: "details" });
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
    await runCalendarImport(SA, U1);
    expect(imported(U1)[0]).toMatchObject({ title: "Dentist" });
    await setImportMode(SA, U1, "busy");
    expect(imported(U1)[0]).toMatchObject({ title: "Busy", location: "", importMode: "busy" });
  });

  it("the workspace switch off resets every member to off and removes every import; on again re-imports nobody", async () => {
    await seedImports();
    expect(await setWorkspaceImportAllowed(SA, false)).toBe(2);
    expect(imported()).toEqual([]);
    expect(conn(U1).importMode).toBe("off");
    expect(conn(U2).importMode).toBe("off");
    await setWorkspaceImportAllowed(SA, true);
    expect(await runCalendarImport(SA, U1)).toMatchObject({ skipped: "not_eligible" });
    expect(provider.syncEvents).not.toHaveBeenCalled();
  });

  it("the agency gate switched off (applyFeatureGates, every path) removes every import", async () => {
    await seedImports();
    await applyFeatureGates(SA, { googleCalendarEnabledByAgency: false });
    expect(imported()).toEqual([]);
  });
});

describe("a key flipped while the pass reads Google: the cleanup wins", () => {
  it.each([
    ["the member opts out", () => setImportMode(SA, U1, "off")],
    ["the admin switches the workspace off", () => setWorkspaceImportAllowed(SA, false)],
    // No cleanup call at all: the pass itself must notice and delete.
    ["the agency gate goes off", () => mem.db.doc(`subAccounts/${SA}`).update({ googleCalendarEnabledByAgency: false })],
  ])("%s → nothing of theirs is left", async (_name, flip) => {
    await seedImports();
    provider.syncEvents.mockImplementation(async () => {
      await flip();
      return page([gev("g1", 2, 3), gev("g2", 4, 5)]);
    });
    expect(await runCalendarImport(SA, U1, { full: true })).toMatchObject({ ok: true, skipped: "settings_changed" });
    expect(imported(U1)).toEqual([]);
  });

  it("the member drops from details to busy → no title survives", async () => {
    mem.seed(CONN(U1), { ...conn(U1), importMode: "details" });
    provider.syncEvents.mockImplementation(async () => {
      await setImportMode(SA, U1, "busy");
      return page([gev("g1", 2, 3)]);
    });
    await runCalendarImport(SA, U1);
    expect(imported(U1).map((e) => e.title)).toEqual([]);
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
    await runCalendarImport(SA, U1);
    expect(imported(U1).map((e) => e.title)).toEqual(["Busy"]);
  });
});

describe("the sweep", () => {
  it("lists opted-in members of allowing workspaces, least recently attempted first", async () => {
    mem.seed(CONN(U1), { ...conn(U1), importLastAttemptAt: new Date(Date.now() - 1_000) });
    mem.seed(CONN(U2), { ...conn(U2), importLastAttemptAt: new Date(Date.now() - 60_000) });
    connectMember("u3", { importMode: "off" });
    mem.seed(`subAccounts/${SA}/private/googleCalendarFake_u1`, { importMode: "busy", uid: "u1" });
    mem.seed("subAccounts/sa_2", { agencyId: AG, calendarImportAllowed: false });
    mem.seed("subAccounts/sa_2/private/googleCalendar_u9", { uid: "u9", importMode: "busy", status: "connected" });
    expect(await listImportTargets()).toEqual([
      { subAccountId: SA, uid: U2 },
      { subAccountId: SA, uid: U1 },
    ]);
  });

  it("the orphan sweep resumes after the cursor the last run saved, and reaching the end resets it", async () => {
    // One owner each: an ineligible owner's imports all go at once.
    for (const id of ["gcal_a", "gcal_b", "gcal_c"]) mem.seed(`events/${id}`, { subAccountId: "sa_gone", source: "google", importOwnerUid: `u_${id}` });
    mem.seed(SWEEP_CURSOR_PATH, { cursor: "gcal_a" });
    expect(await sweepOrphanedImports(Date.now() + 10_000)).toBe(2);
    expect(mem.read("events/gcal_a")).toBeDefined();
    expect(mem.read(SWEEP_CURSOR_PATH)?.cursor).toBeNull();
    expect(await sweepOrphanedImports(Date.now() + 10_000)).toBe(1);
    expect(mem.read("events/gcal_a")).toBeUndefined();
  });

  it("a run out of time saves where it stopped", async () => {
    for (let i = 0; i < 450; i++) {
      mem.seed(`events/gcal_${String(i).padStart(3, "0")}`, { subAccountId: SA, source: "google", importOwnerUid: U1 });
    }
    const base = Date.now();
    let checks = 0;
    // One loop turn (one page of 400), then the deadline has passed.
    vi.spyOn(Date, "now").mockImplementation(() => (checks++ < 1 ? base : base + 60_000));
    expect(await sweepOrphanedImports(base + 1_000)).toBe(0);
    expect(mem.read(SWEEP_CURSOR_PATH)?.cursor).toBe("gcal_399");
  });

  it("the daily orphan sweep deletes imports no key allows any more, and keeps the rest", async () => {
    await seedImports();
    // A cleanup that never ran: U2 opted out, and a workspace that is gone.
    mem.seed(CONN(U2), { ...conn(U2), importMode: "off" });
    mem.seed("events/gcal_orphan", { subAccountId: "sa_gone", source: "google", importOwnerUid: U1 });
    mem.seed("events/gcal_ownerless", { subAccountId: SA, source: "google" });
    mem.seed("events/manual", { subAccountId: SA, title: "Call" });
    expect(await sweepOrphanedImports(Date.now() + 10_000)).toBe(3);
    expect(imported().map((e) => e.importOwnerUid)).toEqual([U1]);
    expect(mem.read("events/manual")).toBeDefined();
  });
});
