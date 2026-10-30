import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One member's import pass (runCalendarImport) over the in-memory Firestore,
 * with a scripted Google: what is imported and how it is stripped, that a
 * re-run writes nothing, incremental sync from the stored token with a full
 * resync when Google refuses it (410), and that an imported doc is never
 * pushed back to Google.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/google-calendar/provider/select", async () => ({
  getGcalProviderFor: async () => (await import("@/test/gcal-import-harness")).provider,
}));

import { mem } from "@/test/gbp-sync-store";
import { CONN, SA, U1, conn, gev, imported, page, provider, resetImport } from "@/test/gcal-import-harness";
import { importedEventDocId } from "./import-map";
import { runCalendarImport } from "./import";
import { pushBookingToGoogle } from "./push";
import { GcalSyncTokenExpiredError } from "./provider/types";

beforeEach(() => {
  resetImport();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const docOf = (googleId: string) => mem.read(`events/${importedEventDocId(SA, U1, googleId)}`);

describe("what a pass imports", () => {
  it("stores busy time only by default: title Busy, no place, notes, guests or links, and asks Google for no titles", async () => {
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3, { attendees: [{ self: true, responseStatus: "accepted" }] })]));
    expect(await runCalendarImport(SA, U1)).toMatchObject({ ok: true, full: true, written: 1 });
    expect(provider.syncEvents.mock.calls[0][1]).toMatchObject({ syncToken: null, details: false });
    const doc = docOf("g1")!;
    expect(doc).toMatchObject({
      title: "Busy",
      location: "",
      notes: "",
      contactId: null,
      meetingUrl: null,
      status: "scheduled",
      source: "google",
      importOwnerUid: U1,
      importMode: "busy",
      territoryId: "global",
      agencyId: "ag_1",
      subAccountId: SA,
      createdByUid: U1,
      allDay: false,
      isLong: false,
    });
    expect(JSON.stringify(doc)).not.toMatch(/Dentist|Main Rd|attendees/);
    // The fields that make an event a booking, an API record or a public page.
    for (const k of ["assignedToUid", "hostUids", "mode", "publicTokenHash", "bookingPageSlug"]) {
      expect(doc).not.toHaveProperty(k);
    }
  });

  it("skips cancelled, Free, declined, LeadStack's own pushed copies and non-appointments", async () => {
    provider.syncEvents.mockResolvedValue(
      page([
        gev("keep", 2, 3),
        gev("cancelled", 2, 3, { status: "cancelled" }),
        gev("free", 2, 3, { transparency: "transparent" }),
        gev("declined", 2, 3, { attendees: [{ self: true, responseStatus: "declined" }] }),
        gev("ours", 2, 3, { extendedProperties: { private: { leadstackEventId: "ev_9" } } }),
        gev("wl", 2, 3, { eventType: "workingLocation" }),
        gev("bday", 2, 3, { eventType: "birthday" }),
        gev("backwards", 3, 2),
        gev("far", 24 * 400, 24 * 400 + 1),
      ]),
    );
    await runCalendarImport(SA, U1);
    expect(imported().map((e) => e.id)).toEqual([importedEventDocId(SA, U1, "keep")]);
  });

  it("imports an all-day event only when it is Busy, midnight to midnight in the calendar's zone, flagged long when multi-day", async () => {
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const after = new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
    provider.syncEvents.mockResolvedValue(
      page(
        [
          { id: "ooo", status: "confirmed", start: { date: day }, end: { date: after } },
          { id: "holiday", status: "confirmed", transparency: "transparent", start: { date: day }, end: { date: after } },
        ],
        { timeZone: "Africa/Johannesburg" },
      ),
    );
    await runCalendarImport(SA, U1);
    expect(docOf("holiday")).toBeUndefined();
    const ooo = docOf("ooo")! as { startAt: { toMillis(): number }; endAt: { toMillis(): number } };
    expect(ooo).toMatchObject({ allDay: true, isLong: true, title: "Busy" });
    // 00:00 SAST is 22:00 UTC the day before.
    expect(ooo.startAt.toMillis()).toBe(Date.parse(`${day}T00:00:00Z`) - 2 * 3_600_000);
    expect(ooo.endAt.toMillis() - ooo.startAt.toMillis()).toBe(2 * 86_400_000);
  });

  it("in details mode stores title and place, but never for a Google-private event", async () => {
    mem.seed(CONN(U1), { ...conn(U1), importMode: "details" });
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3), gev("secret", 4, 5, { visibility: "private" })]));
    await runCalendarImport(SA, U1);
    expect(provider.syncEvents.mock.calls[0][1]).toMatchObject({ details: true });
    expect(docOf("g1")).toMatchObject({ title: "Dentist", location: "12 Main Rd", importMode: "details" });
    expect(docOf("secret")).toMatchObject({ title: "Busy", location: "" });
  });
});

describe("re-runs and incremental sync", () => {
  it("a second full pass over the same calendar writes nothing and duplicates nothing", async () => {
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3), gev("g2", 5, 6)]));
    await runCalendarImport(SA, U1);
    const before = imported().map((e) => [e.id, e.updatedAt]);
    expect(await runCalendarImport(SA, U1, { full: true })).toMatchObject({ ok: true, full: true, written: 0, deleted: 0 });
    expect(imported().map((e) => [e.id, e.updatedAt])).toEqual(before);
    expect(conn(U1)).toMatchObject({ importedCount: 2, importStatus: "ok", importError: null });
  });

  it("the next pass is incremental from the stored token: a change is applied, a cancellation removed, the rest left alone", async () => {
    provider.syncEvents.mockResolvedValueOnce(page([gev("g1", 2, 3), gev("g2", 5, 6), gev("g3", 7, 8)]));
    await runCalendarImport(SA, U1);
    expect(conn(U1).importSyncToken).toBe("tok-1");
    provider.syncEvents.mockResolvedValueOnce(
      page([gev("g1", 2, 4), { id: "g2", status: "cancelled" }], { nextSyncToken: "tok-2" }),
    );
    expect(await runCalendarImport(SA, U1)).toMatchObject({ ok: true, full: false, written: 1, deleted: 1 });
    expect(provider.syncEvents.mock.calls[1][1]).toMatchObject({ syncToken: "tok-1" });
    expect(docOf("g2")).toBeUndefined();
    expect(docOf("g3")).toBeDefined();
    const g1 = docOf("g1") as { endAt: { toMillis(): number }; startAt: { toMillis(): number } };
    expect(g1.endAt.toMillis() - g1.startAt.toMillis()).toBe(2 * 3_600_000);
    expect(conn(U1)).toMatchObject({ importSyncToken: "tok-2", importedCount: 2 });
  });

  it("a sync token Google refuses (410) falls back to a full walk, which also drops what Google no longer has", async () => {
    provider.syncEvents.mockResolvedValueOnce(page([gev("g1", 2, 3), gev("gone", 5, 6)]));
    await runCalendarImport(SA, U1);
    provider.syncEvents
      .mockRejectedValueOnce(new GcalSyncTokenExpiredError())
      .mockResolvedValueOnce(page([gev("g1", 2, 3)], { nextSyncToken: "tok-fresh" }));
    expect(await runCalendarImport(SA, U1)).toMatchObject({ ok: true, full: true, deleted: 1 });
    expect(provider.syncEvents.mock.calls.map((c) => c[1].syncToken)).toEqual([null, "tok-1", null]);
    expect(docOf("gone")).toBeUndefined();
    expect(docOf("g1")).toBeDefined();
    expect(conn(U1).importSyncToken).toBe("tok-fresh");
  });

  it("a truncated full walk proves no absence: nothing is deleted and no token is kept", async () => {
    provider.syncEvents.mockResolvedValueOnce(page([gev("g1", 2, 3), gev("g2", 5, 6)]));
    await runCalendarImport(SA, U1);
    provider.syncEvents.mockResolvedValueOnce(page([gev("g1", 2, 3)], { truncated: true, nextSyncToken: null }));
    expect(await runCalendarImport(SA, U1, { full: true })).toMatchObject({ ok: true, deleted: 0 });
    expect(docOf("g2")).toBeDefined();
    expect(conn(U1)).toMatchObject({ importSyncToken: null, importError: expect.stringMatching(/some were skipped/) });
  });

  it("a failed Google walk writes nothing and records fixed text, never the raw error", async () => {
    provider.syncEvents.mockRejectedValue(new Error("socket hang up: token=ya29.secret"));
    expect(await runCalendarImport(SA, U1)).toMatchObject({ ok: false });
    expect(imported()).toEqual([]);
    expect(conn(U1)).toMatchObject({ importStatus: "error", importError: "Couldn't reach Google Calendar." });
  });
});

describe("one pass at a time, and the full-pass cooldown", () => {
  it("a pass while another holds the lease is skipped and calls Google not at all; the lease is given back after", async () => {
    let inner: unknown;
    provider.syncEvents.mockImplementationOnce(async () => {
      inner = await runCalendarImport(SA, U1);
      return page([gev("g1", 2, 3)]);
    });
    expect(await runCalendarImport(SA, U1)).toMatchObject({ ok: true, written: 1 });
    expect(inner).toMatchObject({ ok: true, skipped: "in_progress" });
    expect(provider.syncEvents).toHaveBeenCalledTimes(1);
    expect(conn(U1)).toMatchObject({ importLeaseId: null, importLeaseUntil: null });
  });

  it("a live lease taken under older keys (another connection, another opt-in) does not block a pass under the current ones", async () => {
    mem.seed(CONN(U1), { ...conn(U1), importLeaseId: "old", importLeaseUntil: new Date(Date.now() + 60_000), importLeasePrint: "stale-print" });
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
    expect(await runCalendarImport(SA, U1)).toMatchObject({ ok: true, written: 1 });
  });

  it("an expired lease (a pass that died) is taken over", async () => {
    mem.seed(CONN(U1), { ...conn(U1), importLeaseId: "dead", importLeaseUntil: new Date(Date.now() - 1) });
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
    expect(await runCalendarImport(SA, U1)).toMatchObject({ ok: true, written: 1 });
  });

  it("a full pass asked for within minFullIntervalMs of the last full attempt is skipped; a later one runs", async () => {
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
    await runCalendarImport(SA, U1, { full: true, minFullIntervalMs: 60_000 });
    expect(await runCalendarImport(SA, U1, { full: true, minFullIntervalMs: 60_000 })).toMatchObject({ skipped: "cooldown" });
    expect(provider.syncEvents).toHaveBeenCalledTimes(1);
    mem.seed(CONN(U1), { ...conn(U1), importLastFullAttemptAt: new Date(Date.now() - 61_000) });
    expect(await runCalendarImport(SA, U1, { full: true, minFullIntervalMs: 60_000 })).toMatchObject({ ok: true, full: true });
  });
});

describe("a calendar too big for one walk", () => {
  it("re-walks ordered by start from now, so what is kept is the nearest upcoming; still no absence, no token", async () => {
    provider.syncEvents.mockResolvedValueOnce(page([gev("g1", 2, 3)]));
    await runCalendarImport(SA, U1);
    provider.syncEvents
      .mockResolvedValueOnce(page([gev("far", 24 * 100, 24 * 100 + 1)], { truncated: true, nextSyncToken: null }))
      .mockResolvedValueOnce(page([gev("soon", 1, 2)], { truncated: true, nextSyncToken: null }));
    await runCalendarImport(SA, U1, { full: true });
    const ordered = provider.syncEvents.mock.calls[2][1];
    expect(ordered).toMatchObject({ ordered: true, syncToken: null });
    expect(Math.abs(ordered.timeMin.getTime() - Date.now())).toBeLessThan(60_000);
    expect(docOf("soon")).toBeDefined();
    expect(docOf("far")).toBeUndefined();
    expect(docOf("g1")).toBeDefined();
    expect(conn(U1)).toMatchObject({ importSyncToken: null, importError: expect.stringMatching(/some were skipped/) });
  });

  it("an ordered re-walk that fails keeps the first walk's result, still truncated", async () => {
    provider.syncEvents.mockResolvedValueOnce(page([gev("g1", 2, 3)]));
    await runCalendarImport(SA, U1);
    provider.syncEvents
      .mockResolvedValueOnce(page([gev("first", 5, 6)], { truncated: true, nextSyncToken: null }))
      .mockRejectedValueOnce(new Error("timeout"));
    expect(await runCalendarImport(SA, U1, { full: true })).toMatchObject({ ok: true, deleted: 0 });
    expect(docOf("first")).toBeDefined();
    expect(docOf("g1")).toBeDefined();
    expect(conn(U1)).toMatchObject({ importStatus: "ok", importSyncToken: null, importError: expect.stringMatching(/some were skipped/) });
  });
});

describe("a revoked grant", () => {
  it("loses its imports and then its opt-in, so the sweep stops listing it", async () => {
    const { listImportTargets } = await import("./import-state");
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
    await runCalendarImport(SA, U1);
    mem.seed(CONN(U1), { ...conn(U1), status: "revoked" });
    expect(await listImportTargets()).toEqual([{ subAccountId: SA, uid: U1 }]);
    expect(await runCalendarImport(SA, U1)).toMatchObject({ skipped: "not_eligible", deleted: 1 });
    expect(conn(U1)).toMatchObject({ importMode: "off", importSyncToken: null });
    expect(await listImportTargets()).toEqual([]);
  });

  it("a connected member whose workspace key is off keeps the opt-in (re-enabling resumes)", async () => {
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
    await runCalendarImport(SA, U1);
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`), googleCalendarEnabledByAgency: false });
    expect(await runCalendarImport(SA, U1)).toMatchObject({ skipped: "not_eligible", deleted: 1 });
    expect(conn(U1).importMode).toBe("busy");
  });

  it("found revoked mid-walk: the pass's own cleanup also retires the opt-in", async () => {
    provider.syncEvents.mockResolvedValueOnce(page([gev("g1", 2, 3)]));
    await runCalendarImport(SA, U1);
    provider.syncEvents.mockImplementationOnce(async () => {
      mem.seed(CONN(U1), { ...conn(U1), status: "revoked" });
      throw new Error("invalid_grant");
    });
    await runCalendarImport(SA, U1, { full: true });
    expect(imported(U1)).toEqual([]);
    expect(conn(U1).importMode).toBe("off");
  });
});

describe("rewrites", () => {
  it("are a whole-doc set: a field outside the import's shape does not survive, createdAt does", async () => {
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
    await runCalendarImport(SA, U1);
    const id = importedEventDocId(SA, U1, "g1");
    const createdAt = docOf("g1")!.createdAt;
    mem.seed(`events/${id}`, { ...docOf("g1"), title: "stale", assignedToUid: "host_x" });
    await runCalendarImport(SA, U1, { full: true });
    expect(docOf("g1")).toMatchObject({ title: "Busy", createdAt });
    expect(docOf("g1")).not.toHaveProperty("assignedToUid");
  });
});

describe("an imported event is never a booking", () => {
  it("is never pushed back to Google", async () => {
    provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
    await runCalendarImport(SA, U1);
    await pushBookingToGoogle(importedEventDocId(SA, U1, "g1"));
    expect(provider.putEvent).not.toHaveBeenCalled();
    expect(provider.deleteEvent).not.toHaveBeenCalled();
  });
});
