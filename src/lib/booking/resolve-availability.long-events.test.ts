import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, SA, at, mem, resetBookingHarness, seedPage } from "@/test/booking-harness";

/**
 * Events longer than a slot (`isLong`) are read by their own narrow query, so
 * the main busy read stays short. That query needs a composite index; until
 * it is deployed it must fail soft (no long events) rather than break
 * availability. Inside a book/reschedule transaction it is read outside the
 * transaction, so old events aren't read-locked.
 */

const INDEX_MISSING = Object.assign(
  new Error("9 FAILED_PRECONDITION: The query requires an index."),
  { code: 9 },
);
let failLong = false;
type Q = { where: (f: string, op: string, v: unknown) => Q; get: () => Promise<unknown> };
const failing: Q = { where: () => failing, get: () => Promise.reject(INDEX_MISSING) };
const wrap = (q: Q): Q => ({
  where: (f, op, v) => (f === "isLong" && failLong ? failing : wrap(q.where(f, op, v))),
  get: () => q.get(),
});
vi.mock("@/lib/firebase/admin", async () => {
  const { mem: m } = await import("@/test/booking-harness");
  return {
    getAdminDb: () => ({
      ...m.db,
      collection: (name: string) => wrap(m.db.collection(name) as unknown as Q),
    }),
  };
});

const { resolvePageAvailability } = await import("./resolve-availability");

const ts = (iso: string) => {
  const d = new Date(iso);
  return { toDate: () => d, toMillis: () => d.getTime() };
};
function seedLong(isLong: boolean) {
  // Began 20 days ago, runs to the end of Monday 2026-09-14.
  mem.seed("events/leave", {
    subAccountId: SA,
    agencyId: "ag1",
    status: "scheduled",
    title: "Leave",
    startAt: ts("2026-08-25T00:00:00Z"),
    endAt: ts("2026-09-15T00:00:00Z"),
    ...(isLong ? { isLong: true } : {}),
  });
}
const resolve = (txn?: FirebaseFirestore.Transaction) =>
  resolvePageAvailability({ subAccountId: SA, page: seedPage("p"), now: NOW, toInstant: at("23:59"), txn });

beforeEach(() => {
  resetBookingHarness();
  failLong = false;
});
afterEach(() => vi.useRealTimers());

describe("long events", () => {
  it("block every slot while they run, however long ago they began", async () => {
    seedLong(true);
    expect(await resolve()).toEqual([]);
  });

  it("fail soft while the index is missing: slots as if there were none, no throw", async () => {
    seedLong(true);
    failLong = true;
    expect(await resolve()).toHaveLength(6);
  });

  it("are read outside the transaction; only the short busy read goes through it", async () => {
    seedLong(true);
    const out = await mem.db.runTransaction(async (txn) => {
      const get = vi.spyOn(txn, "get");
      const slots = await resolve(txn as unknown as FirebaseFirestore.Transaction);
      expect(get).toHaveBeenCalledTimes(1);
      return slots;
    });
    expect(out).toEqual([]);
  });
});
