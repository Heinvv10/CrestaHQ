import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Events imported from a member's Google Calendar never leave the CRM: the
 * .ics feeds (all bookings, and per host) leave them out — and, however many
 * there are, they never crowd a real booking out of the feed's 500 cap.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async (uid: string) => ({ uid, customClaims: {} }) }),
}));

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";
process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
const { GET } = await import("./route");
const { buildCalendarFeedUrl, buildHostCalendarFeedUrl } = await import("@/lib/booking/calendar-feed-token");

const fetchFeed = async (url: string) => {
  const res = await GET(new Request(url), { params: Promise.resolve({ id: "sa1" }) });
  expect(res.status).toBe(200);
  return res.text();
};
const HOUR = 60 * 60_000;
const seed = (id: string, title: string, startInHours: number, extra: object = {}) =>
  mem.seed(`events/${id}`, {
    subAccountId: "sa1",
    status: "scheduled",
    title,
    startAt: new Date(Date.now() + startInHours * HOUR),
    endAt: new Date(Date.now() + (startInHours + 1) * HOUR),
    ...extra,
  });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { name: "Fixture", agencyId: "ag1" });
  mem.seed("subAccounts/sa1/subAccountMembers/ann", { uid: "ann", status: "active", displayName: "Ann" });
});

describe("calendar.ics and imported Google events", () => {
  it("the all-bookings feed leaves them out", async () => {
    seed("b1", "Team booking", 24);
    seed("g1", "Private dentist", 25, { source: "google" });
    const ics = await fetchFeed(buildCalendarFeedUrl("sa1", "ann"));
    expect(ics).toContain("Team booking");
    expect(ics).not.toContain("Private dentist");
  });

  it("the per-host feed leaves them out", async () => {
    seed("b1", "Ann's booking", 24, { assignedToUid: "ann" });
    seed("g1", "Ann's dentist", 25, { assignedToUid: "ann", source: "google" });
    const ics = await fetchFeed(buildHostCalendarFeedUrl("sa1", "ann"));
    expect(ics).toContain("Ann's booking");
    expect(ics).not.toContain("Ann's dentist");
  });

  it("600 earlier imported events don't push a real booking out of the cap", async () => {
    for (let i = 0; i < 600; i++) seed(`g${i}`, `Imported ${i}`, 1 + i / 1000, { source: "google" });
    seed("late", "Later booking", 48);
    const ics = await fetchFeed(buildCalendarFeedUrl("sa1", "ann"));
    expect(ics).toContain("Later booking");
    expect(ics).not.toContain("Imported");
  });
});
