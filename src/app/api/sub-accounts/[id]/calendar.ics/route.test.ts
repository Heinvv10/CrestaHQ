import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The per-host feed carries every booking the member attends: the ones they
 * own and the collective ones listing them in `hostUids`.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";
const { GET } = await import("./route");
const { generateHostCalendarFeedToken } = await import("@/lib/booking/calendar-feed-token");

const seed = (id: string, title: string, extra: object) =>
  mem.seed(`events/${id}`, {
    subAccountId: "sa1",
    status: "scheduled",
    title,
    startAt: new Date(Date.now() + 24 * 60 * 60_000),
    endAt: new Date(Date.now() + 25 * 60 * 60_000),
    ...extra,
  });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { name: "Fixture" });
  mem.seed("subAccounts/sa1/subAccountMembers/b", { uid: "b", status: "active", displayName: "Bob" });
});

describe("per-host calendar.ics", () => {
  it("includes owned and collective bookings, each once, and nobody else's", async () => {
    seed("owned", "Owned by Bob", { assignedToUid: "b" });
    seed("col", "Collective with Bob", { assignedToUid: "a", hostUids: ["a", "b"] });
    seed("both", "Bob owns and lists", { assignedToUid: "b", hostUids: ["b", "a"] });
    seed("anns", "Ann only", { assignedToUid: "a" });

    const t = generateHostCalendarFeedToken("sa1", "b");
    const res = await GET(new Request(`http://x/api?host=b&t=${t}`), {
      params: Promise.resolve({ id: "sa1" }),
    });
    expect(res.status).toBe(200);
    const ics = await res.text();
    expect(ics).toContain("Owned by Bob");
    expect(ics).toContain("Collective with Bob");
    expect(ics.match(/Bob owns and lists/g)).toHaveLength(1);
    expect(ics).not.toContain("Ann only");
  });
});
