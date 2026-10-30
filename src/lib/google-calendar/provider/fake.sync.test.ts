import { describe, expect, it } from "vitest";
import { createFakeGcalProvider, type FakeCalendar, type FakeCalendarStore } from "./fake";
import { GcalSyncTokenExpiredError } from "./types";

/** The dev/CI fake's import walk: same contract as Google's (tokens bound to the member, 410, cancellations). */

function setup(calendar: FakeCalendar) {
  const cals = new Map<string, FakeCalendar>([["sa:u", calendar]]);
  const store: FakeCalendarStore = {
    get: async (sa, uid) => cals.get(`${sa}:${uid}`) ?? null,
    set: async (sa, uid, c) => void cals.set(`${sa}:${uid}`, c),
  };
  const p = createFakeGcalProvider(store, { subAccountId: "sa", uid: "u" });
  const other = createFakeGcalProvider(store, { subAccountId: "sa", uid: "v" });
  return { p, other, cal: () => cals.get("sa:u")! };
}
const W = { timeMin: new Date("2026-10-01T00:00:00Z"), timeMax: new Date("2026-10-08T00:00:00Z"), maxPages: 5 };
const EV = { id: "e1", status: "confirmed", summary: "Dentist", location: "Main Rd", description: "secret", start: { dateTime: "2026-10-02T09:00:00Z" }, end: { dateTime: "2026-10-02T10:00:00Z" } };

describe("fake syncEvents", () => {
  it("never returns a description; titles and places only with details", async () => {
    const { p } = setup({ events: [EV] });
    const token = (await p.exchangeCode("fake-gcal-code:sa:u", "")).accessToken;
    const busy = await p.syncEvents(token, { ...W, syncToken: null, details: false });
    expect(busy.items).toEqual([{ id: "e1", status: "confirmed", start: EV.start, end: EV.end }]);
    expect(busy.nextSyncToken).toMatch(/^fake-gcal-sync:sa:u:/);
    const details = await p.syncEvents(token, { ...W, syncToken: null, details: true });
    expect(details.items[0]).toMatchObject({ summary: "Dentist", location: "Main Rd" });
    expect(details.items[0]).not.toHaveProperty("description");
  });

  it("incremental: deletions arrive as cancelled; another member's token or a scripted expiry is a 410", async () => {
    const { p, other, cal } = setup({ events: [EV], deletedIds: ["gone"] });
    const token = (await p.exchangeCode("fake-gcal-code:sa:u", "")).accessToken;
    const { nextSyncToken } = await p.syncEvents(token, { ...W, syncToken: null, details: false });
    const inc = await p.syncEvents(token, { ...W, syncToken: nextSyncToken, details: false });
    expect(inc.items.map((e) => [e.id, e.status])).toEqual([["e1", "confirmed"], ["gone", "cancelled"]]);
    const vToken = (await other.exchangeCode("fake-gcal-code:sa:v", "")).accessToken;
    await expect(other.syncEvents(vToken, { ...W, syncToken: nextSyncToken, details: false })).rejects.toBeInstanceOf(GcalSyncTokenExpiredError);
    cal().expireSyncToken = true;
    await expect(p.syncEvents(token, { ...W, syncToken: nextSyncToken, details: false })).rejects.toBeInstanceOf(GcalSyncTokenExpiredError);
    expect((await p.syncEvents(token, { ...W, syncToken: nextSyncToken, details: false })).items).toHaveLength(2);
  });
});
