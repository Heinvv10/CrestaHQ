import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A collective booking occupies every host in `hostUids`, not only its owner
 * (`assignedToUid`): round-robin load counts it for each of them.
 */

const mem = createMemoryFirestore();

// Optionally fail the `hostUids array-contains` half (e.g. index not built).
let failListed = false;
type Q = { where: (f: string, op: string, v: unknown) => Q; get: () => Promise<unknown> };
const failing: Q = { where: () => failing, get: () => Promise.reject(new Error("9 FAILED_PRECONDITION")) };
const wrap = (q: Q): Q => ({
  where: (f, op, v) => (failListed && op === "array-contains" ? failing : wrap(q.where(f, op, v))),
  get: () => q.get(),
});
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ collection: (p: string) => wrap(mem.db.collection(p) as unknown as Q) }),
}));

const { loadHostUpcomingCounts, queryHostEvents } = await import("./hosts");

const NOW = new Date("2026-09-14T06:00:00Z");
const seed = (id: string, extra: object) =>
  mem.seed(`events/${id}`, {
    subAccountId: "sa1",
    status: "scheduled",
    startAt: new Date("2026-09-15T09:00:00Z"),
    endAt: new Date("2026-09-15T09:30:00Z"),
    ...extra,
  });

beforeEach(() => {
  mem.clear();
  failListed = false;
});

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

describe("queryHostEvents", () => {
  it("never returns an imported Google event, owned or collective", async () => {
    seed("booking", { assignedToUid: "b" });
    seed("g-owned", { assignedToUid: "b", source: "google" });
    seed("g-listed", { hostUids: ["b"], source: "google" });
    const docs = await queryHostEvents("sa1", "b", (q) => q);
    expect(docs.map((d) => d.id)).toEqual(["booking"]);
  });

  it("keeps the owned half when the collective half fails", async () => {
    seed("owned", { assignedToUid: "b" });
    seed("col", { assignedToUid: "a", hostUids: ["a", "b"] });
    failListed = true;
    const docs = await queryHostEvents("sa1", "b", (q) => q);
    expect(docs.map((d) => d.id)).toEqual(["owned"]);
  });
});
