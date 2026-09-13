import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, at, resetBookingHarness, seedEvent, seedPage } from "@/test/booking-harness";

/**
 * The resolver's own contract: how a failing busy query surfaces (raw inside
 * a transaction so runTransaction can retry it, wrapped outside), and how
 * pre-loaded external busy time merges with event busy per host.
 */

/** Null ⇒ the harness's in-memory Firestore. */
let failingDb: unknown = null;
vi.mock("@/lib/firebase/admin", async () => {
  const { mem: m } = await import("@/test/booking-harness");
  return { getAdminDb: () => failingDb ?? m.db };
});

const { BusyQueryError, resolvePageAvailability } = await import("./resolve-availability");

const A = { uid: "a", name: "Ann" };
const B = { uid: "b", name: "Bob" };
const DAY_END = at("23:59");
const startsOf = (slots: { startAt: Date; hostUids: string[] }[], uid?: string) =>
  slots
    .filter((s) => uid === undefined || s.hostUids.includes(uid))
    .map((s) => s.startAt.toISOString().slice(11, 16));

beforeEach(() => {
  resetBookingHarness();
  failingDb = null;
});
afterEach(() => vi.useRealTimers());

describe("a failing busy query", () => {
  const raw = Object.assign(new Error("10 ABORTED: contention"), { code: 10 });
  const query: { where: () => unknown; get: () => Promise<never> } = {
    where: () => query,
    get: () => Promise.reject(raw),
  };

  beforeEach(() => {
    failingDb = { collection: () => query };
  });

  const run = (txn?: unknown) =>
    resolvePageAvailability({
      subAccountId: "sa1",
      page: seedPage("p"),
      now: NOW,
      toInstant: DAY_END,
      txn: txn as FirebaseFirestore.Transaction | undefined,
    });

  it("inside a transaction: the raw error, so runTransaction can retry it", async () => {
    const txn = { get: () => Promise.reject(raw) };
    const err = await run(txn).catch((e: unknown) => e);
    expect(err).toBe(raw);
    expect(err).not.toBeInstanceOf(BusyQueryError);
  });

  it("outside one: a BusyQueryError carrying the original", async () => {
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusyQueryError);
    expect((err as InstanceType<typeof BusyQueryError>).original).toBe(raw);
  });
});

describe("external busy", () => {
  it("blocks only the host it is tagged with, alongside event busy", async () => {
    const page = seedPage("rr", { hosts: [A, B] });
    seedEvent("bobs", "11:00", "11:30", { assignedToUid: "b" });

    const slots = await resolvePageAvailability({
      subAccountId: "sa1",
      page,
      now: NOW,
      toInstant: DAY_END,
      externalBusy: [{ startAt: at("09:00"), endAt: at("10:00"), hostUids: ["a"] }],
    });

    expect(startsOf(slots, "a")).toEqual(["10:00", "10:30", "11:00", "11:30"]);
    expect(startsOf(slots, "b")).toEqual(["09:00", "09:30", "10:00", "10:30", "11:30"]);
  });

  it("blocks a collective page's slot when any one host is externally busy", async () => {
    const page = seedPage("col", { calendarType: "collective", hosts: [A, B] });
    const slots = await resolvePageAvailability({
      subAccountId: "sa1",
      page,
      now: NOW,
      toInstant: DAY_END,
      externalBusy: [{ startAt: at("09:00"), endAt: at("09:30"), hostUids: ["b"] }],
    });
    expect(startsOf(slots)[0]).toBe("09:30");
  });
});

describe("external busy and buffers", () => {
  it("gets only the new slot's buffers, never a same-page booking's", async () => {
    // 15-min after-buffer at a 15-min interval; external busy 10:00–10:30.
    const slots = await resolvePageAvailability({
      subAccountId: "sa1",
      page: seedPage("p", { bufferMinutes: 15, slotIntervalMinutes: 15 }),
      now: NOW,
      toInstant: DAY_END,
      externalBusy: [{ startAt: at("10:00"), endAt: at("10:30"), hostUids: [] }],
    });
    const starts = startsOf(slots);
    expect(starts).not.toContain("09:30"); // its after-buffer runs into 10:00
    expect(starts).toContain("09:15");
    expect(starts).toContain("10:30"); // a same-page booking would forbid this
  });

  it("a same-page booking at the same time keeps its buffers (contrast)", async () => {
    seedEvent("own", "10:00", "10:30", { bookingPageSlug: "p" });
    const slots = await resolvePageAvailability({
      subAccountId: "sa1",
      page: seedPage("p", { bufferMinutes: 15, slotIntervalMinutes: 15 }),
      now: NOW,
      toInstant: DAY_END,
    });
    expect(startsOf(slots)).not.toContain("10:30");
    expect(startsOf(slots)).toContain("10:45");
  });
});
