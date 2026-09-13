import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, at, mem, resetBookingHarness, seedEvent, seedPage } from "@/test/booking-harness";

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

const { BusyQueryError, departedHostMessage, movingEventOf, resolvePageAvailability } =
  await import("./resolve-availability");

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

describe("movingEventOf", () => {
  const ev = (startIso: string, endIso: string) =>
    movingEventOf("e", {
      startAt: new Date(startIso),
      endAt: new Date(endIso),
      assignedToUid: "a",
    } as never);

  it("takes the event's own whole-minute length", () => {
    expect(ev("2026-09-14T09:00:00Z", "2026-09-14T10:30:00Z")).toEqual({
      id: "e",
      hostUids: ["a"],
      durationMinutes: 90,
    });
  });

  it.each([
    ["ends before it starts", "2026-09-14T09:00:00Z", "2026-09-14T08:00:00Z"],
    ["zero length", "2026-09-14T09:00:00Z", "2026-09-14T09:00:00Z"],
    ["1 ms", "2026-09-14T09:00:00.000Z", "2026-09-14T09:00:00.001Z"],
    ["under 5 min", "2026-09-14T09:00:00Z", "2026-09-14T09:04:00Z"],
    ["not whole minutes", "2026-09-14T09:00:00Z", "2026-09-14T09:30:30Z"],
    ["over 8 h", "2026-09-14T09:00:00Z", "2026-09-14T17:01:00Z"],
    ["a year", "2026-09-14T09:00:00Z", "2027-09-14T09:00:00Z"],
  ])("%s: unknown length (0)", (_label, start, end) => {
    expect(ev(start, end).durationMinutes).toBe(0);
  });
});

describe("departedHostMessage", () => {
  beforeEach(() => {
    // Like the Admin SDK: a document path needs an even number of non-empty segments.
    failingDb = {
      doc: (path: string) => {
        const parts = path.split("/");
        if (parts.length % 2 !== 0 || parts.some((p) => p === "")) {
          throw new Error(`invalid document path: ${path}`);
        }
        return mem.db.doc(path);
      },
    };
  });

  const page = { hosts: [B] };
  const event = (over: object) =>
    ({ subAccountId: "sa1", assignedToUid: null, assignedToName: null, ...over }) as never;

  it.each([
    ["a slash", { assignedToUid: "x/y", assignedToName: "Xy" }, "Xy"],
    ["an empty collective host", { hostUids: ["", "b"] }, "Your host"],
  ])("a host uid with %s is refused, not thrown", async (_label, over, who) => {
    await expect(departedHostMessage(page, event(over))).resolves.toBe(
      `${who} is no longer available — please contact the business to rebook.`,
    );
  });

  it("an active member off the page is still fine", async () => {
    mem.seed("subAccounts/sa1/subAccountMembers/a", { uid: "a", status: "active" });
    await expect(departedHostMessage(page, event({ assignedToUid: "a" }))).resolves.toBeNull();
  });
});
