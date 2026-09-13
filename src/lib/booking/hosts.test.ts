import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A collective booking occupies every host in `hostUids`, not only its owner
 * (`assignedToUid`): round-robin load counts it for each of them.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { loadHostUpcomingCounts } = await import("./hosts");

const NOW = new Date("2026-09-14T06:00:00Z");
const seed = (id: string, extra: object) =>
  mem.seed(`events/${id}`, {
    subAccountId: "sa1",
    status: "scheduled",
    startAt: new Date("2026-09-15T09:00:00Z"),
    endAt: new Date("2026-09-15T09:30:00Z"),
    ...extra,
  });

beforeEach(() => mem.clear());

describe("loadHostUpcomingCounts", () => {
  it("counts a collective booking for every one of its hosts, once each", async () => {
    seed("col", { assignedToUid: "a", hostUids: ["a", "b"] });
    seed("rr", { assignedToUid: "b" });
    seed("cancelled", { assignedToUid: "c", hostUids: ["c"], status: "cancelled" });
    seed("past", { assignedToUid: "c", startAt: new Date("2026-09-13T09:00:00Z") });
    seed("other-sa", { assignedToUid: "c", subAccountId: "sa2" });

    const counts = await loadHostUpcomingCounts("sa1", ["a", "b", "c"], NOW);
    expect(Object.fromEntries(counts)).toEqual({ a: 1, b: 2, c: 0 });
  });
});
