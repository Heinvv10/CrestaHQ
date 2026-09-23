import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The all-bookings feed is minted per member (bound to their uid) and checked
 * against current membership on every poll — a collaborator removed from the
 * sub-account must stop receiving the team's bookings, even though their
 * calendar app keeps polling the URL they copied.
 */

const mem = createMemoryFirestore();
const claims = new Map<string, Record<string, unknown>>();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async (uid: string) => ({ uid, customClaims: claims.get(uid) ?? {} }) }),
}));

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";
process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
const { GET } = await import("./route");
const { buildCalendarFeedUrl } = await import("@/lib/booking/calendar-feed-token");
const { createHmac } = await import("node:crypto");
/** The pre-S11 shared token: HMAC("calfeed:" + subAccountId), no user in it. */
const legacyToken = (sa: string) =>
  createHmac("sha256", "test-secret").update(`calfeed:${sa}`).digest("base64url");

const fetchFeed = (url: string) =>
  GET(new Request(url), { params: Promise.resolve({ id: "sa1" }) });

beforeEach(() => {
  mem.clear();
  claims.clear();
  mem.seed("subAccounts/sa1", { name: "Fixture", agencyId: "ag1" });
  mem.seed("subAccounts/sa1/subAccountMembers/ann", { uid: "ann", status: "active" });
  mem.seed("events/e1", {
    subAccountId: "sa1",
    status: "scheduled",
    title: "Team booking",
    startAt: new Date(Date.now() + 24 * 60 * 60_000),
    endAt: new Date(Date.now() + 25 * 60 * 60_000),
  });
});

describe("all-bookings calendar.ics", () => {
  it("serves a current member's own feed URL", async () => {
    const res = await fetchFeed(buildCalendarFeedUrl("sa1", "ann"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Team booking");
  });

  it("stops serving once the member is removed or deactivated", async () => {
    const url = buildCalendarFeedUrl("sa1", "ann");
    mem.seed("subAccounts/sa1/subAccountMembers/ann", { uid: "ann", status: "removed" });
    expect((await fetchFeed(url)).status).toBe(404);
    await mem.db.doc("subAccounts/sa1/subAccountMembers/ann").delete();
    expect((await fetchFeed(url)).status).toBe(404);
  });

  it("serves the parent agency's owner, who has no member row", async () => {
    claims.set("owner", { status: "active", agencyRole: "owner", agencyId: "ag1" });
    expect((await fetchFeed(buildCalendarFeedUrl("sa1", "owner"))).status).toBe(200);
    claims.set("owner", { status: "active", agencyRole: "owner", agencyId: "other-agency" });
    expect((await fetchFeed(buildCalendarFeedUrl("sa1", "owner"))).status).toBe(404);
  });

  it("refuses a token minted for another uid, and the old shared per-sub-account token", async () => {
    const annUrl = new URL(buildCalendarFeedUrl("sa1", "ann"));
    annUrl.searchParams.set("u", "bob");
    mem.seed("subAccounts/sa1/subAccountMembers/bob", { uid: "bob", status: "active" });
    expect((await fetchFeed(annUrl.toString())).status).toBe(404);
    expect((await fetchFeed(`https://app.test/api/sub-accounts/sa1/calendar.ics?t=${legacyToken("sa1")}`)).status).toBe(404);
  });
});
