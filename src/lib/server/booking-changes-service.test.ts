import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, mem, resetBookingHarness, seedEvent, seedPage } from "@/test/booking-harness";

/**
 * The attendee cancel/reschedule service over the in-memory Firestore (real
 * transactions: a doc read by a transaction that changes before it commits
 * re-runs it). The guard is the caller's credential check and runs inside
 * the transaction; only side effects are spies.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => true,
  sendEmail: fx.send,
  tenantFrom: () => "x@example.com",
}));
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());
const fx = vi.hoisted(() => ({
  activity: vi.fn(async () => undefined),
  trigger: vi.fn(async () => undefined),
  webhook: vi.fn(async () => undefined),
  reminders: vi.fn(async () => undefined),
  push: vi.fn(async () => undefined),
  send: vi.fn(async (_m: { to: string; text: string }) => undefined),
}));
vi.mock("@/lib/booking/lifecycle", () => ({
  emitBookingWebhook: fx.webhook,
  fireBookingTrigger: fx.trigger,
  recordBookingActivity: fx.activity,
  scheduleEventReminders: fx.reminders,
}));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: fx.push }));
vi.mock("@/lib/google-calendar/busy", () => ({ loadGoogleBusyForEvent: async () => [] }));

const { flushAfterResponse } = await import("@/lib/server/after-response");
const { cancelBooking, rescheduleBooking, rescheduleBookingAsOperator } = await import("./booking-changes-service");
type Guard = import("./booking-changes-service").BookingChangeGuard;

const HASH = "hash_live";
const byToken = (e: { publicTokenHash?: string | null }) => e.publicTokenHash === HASH;
const allow = () => true;
const startOf = () => (mem.read("events/e1")?.startAt as { toDate?: () => Date } | Date);
const startMs = () => {
  const s = startOf();
  return s instanceof Date ? s.getTime() : s.toDate!().getTime();
};
const cancel = (guard: Guard = byToken) =>
  cancelBooking({ eventId: "e1", guard, note: "by attendee" });
const moveTo = (start: string, end: string | null, guard: Guard = byToken) =>
  rescheduleBooking({ eventId: "e1", newStart: at(start), newEnd: end ? at(end) : null, guard });

beforeEach(() => {
  resetBookingHarness();
  Object.values(fx).forEach((f) => f.mockClear());
  seedPage("p");
  seedEvent("e1", "09:00", "09:30", {
    bookingPageSlug: "p",
    source: "booking_page",
    contactId: "c1",
    publicTokenHash: HASH,
    title: "Intro",
  });
});
afterEach(() => vi.useRealTimers());

describe("guard refusal", () => {
  it("cancel: invalid, nothing written, no side effects", async () => {
    const before = mem.read("events/e1");
    expect(await cancel(() => false)).toEqual({ ok: false, code: "invalid" });
    await flushAfterResponse();
    expect(mem.read("events/e1")).toEqual(before);
    expect(fx.activity).not.toHaveBeenCalled();
    expect(fx.push).not.toHaveBeenCalled();
  });

  it("reschedule: invalid, time and token unchanged", async () => {
    const before = mem.read("events/e1");
    expect(await moveTo("10:00", "10:30", () => false)).toEqual({ ok: false, code: "invalid" });
    expect(mem.read("events/e1")).toEqual(before);
    expect(fx.reminders).not.toHaveBeenCalled();
    expect(fx.push).not.toHaveBeenCalled();
  });

  it("the guard sees the live event, with its id from the snapshot", async () => {
    const seen: unknown[] = [];
    await cancel((e) => (seen.push(e), false));
    expect(seen).toEqual([expect.objectContaining({ id: "e1", publicTokenHash: HASH, status: "scheduled" })]);
  });

  it("an imported Google event is refused even when the guard allows it", async () => {
    seedEvent("e1", "09:00", "09:30", { bookingPageSlug: "p", source: "google", publicTokenHash: HASH });
    expect(await cancel(allow)).toEqual({ ok: false, code: "invalid" });
    expect(await moveTo("10:00", "10:30", allow)).toEqual({ ok: false, code: "invalid" });
    expect(mem.read("events/e1")?.status).toBe("scheduled");
  });

  it("an id that isn't one path segment is refused, even where it names a doc", async () => {
    mem.seed("events/e1/notes/n1", { ...mem.read("events/e1"), id: "n1" });
    const nested = { eventId: "e1/notes/n1", guard: allow };
    expect(await cancelBooking({ ...nested, note: "n" })).toEqual({ ok: false, code: "invalid" });
    expect(
      await rescheduleBooking({ ...nested, newStart: at("10:00"), newEnd: at("10:30") }),
    ).toEqual({ ok: false, code: "invalid" });
    await expect(rescheduleBookingAsOperator(nested.eventId, at("10:00"), at("10:30"))).rejects.toMatchObject({
      httpStatus: 404,
    });
    expect(mem.read("events/e1/notes/n1")).toMatchObject({ status: "scheduled", publicTokenHash: HASH });
  });
});

describe("cancel", () => {
  it("a double cancel succeeds twice and runs its side effects once", async () => {
    const first = await cancel();
    const second = await cancel();
    await flushAfterResponse();
    expect(first).toMatchObject({ ok: true, alreadyCancelled: false });
    expect(second).toMatchObject({ ok: true, alreadyCancelled: true });
    expect(mem.read("events/e1")).toMatchObject({ status: "cancelled", cancelReason: "by_visitor" });
    expect(fx.activity).toHaveBeenCalledTimes(1);
    expect(fx.activity).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e1" }),
      "booking_cancelled",
      { extra: "by attendee" },
    );
    expect(fx.trigger).toHaveBeenCalledTimes(1);
    expect(fx.webhook).toHaveBeenCalledTimes(1);
    expect(fx.push).toHaveBeenCalledTimes(1);
  });

  it("emails the attendee that THEY cancelled — not that the host did", async () => {
    mem.seed("contacts/c1", { name: "Thandi", email: "thandi@example.co.za", subAccountId: "sa1" });
    await cancel();
    expect(fx.send).toHaveBeenCalledTimes(1);
    const mail = fx.send.mock.calls[0]![0];
    expect(mail.to).toBe("thandi@example.co.za");
    expect(mail.text).toContain("has been cancelled.");
    expect(mail.text).not.toContain("by the host");
  });

  it("a meeting that already took place can't be cancelled", async () => {
    seedEvent("e1", "09:00", "09:30", { status: "completed", publicTokenHash: HASH });
    expect(await cancel()).toEqual({ ok: false, code: "bad_state", message: "This meeting has already taken place." });
  });
});

describe("reschedule", () => {
  it("moves the booking, rotates the token, stamps the bookkeeping", async () => {
    const res = await moveTo("10:00", "10:30");
    expect(res.ok).toBe(true);
    const doc = mem.read("events/e1")!;
    expect(startMs()).toBe(at("10:00").getTime());
    expect(doc.publicTokenHash).not.toBe(HASH);
    expect(doc).toMatchObject({ rescheduleCount: 1, icsSequence: 2, isLong: false });
    // The "Updated:" mail carries the link, so this push may replace a fallback.
    expect(fx.push).toHaveBeenCalledWith("e1", { replaceFallback: true });
  });

  it("with no end keeps the booking's own length", async () => {
    seedEvent("e1", "09:00", "10:00", { bookingPageSlug: "p", publicTokenHash: HASH });
    seedPage("p", { durationMinutes: 60 });
    const res = await moveTo("11:00", null);
    expect(res).toMatchObject({ ok: true, newEnd: at("12:00") });
  });

  it("clears a stale isLong when it moves the booking back to a slot", async () => {
    seedEvent("e1", "09:00", "09:30", { bookingPageSlug: "p", publicTokenHash: HASH, isLong: true });
    expect((await moveTo("10:00", "10:30")).ok).toBe(true);
    expect(mem.read("events/e1")?.isLong).toBe(false);
  });

  it("a cancelled booking can't be moved", async () => {
    await cancel();
    expect(await moveTo("10:00", "10:30")).toEqual({
      ok: false,
      code: "bad_state",
      message: "This booking was cancelled. Please re-book.",
    });
    expect(startMs()).toBe(at("09:00").getTime());
  });

  it("a time in the past is refused before any read", async () => {
    expect(await moveTo("05:00", "05:30", allow)).toEqual({
      ok: false,
      code: "bad_request",
      message: "Choose a time in the future.",
    });
    expect(await moveTo("10:30", "10:00", allow)).toMatchObject({ ok: false, code: "bad_request" });
  });
});

describe("concurrent changes on one booking", () => {
  /** Outcome must match the doc: exactly one wins, and the doc shows that one. */
  function expectConsistent(c: { ok: boolean }, r: { ok: boolean }) {
    const doc = mem.read("events/e1")!;
    expect([c.ok, r.ok].filter(Boolean)).toHaveLength(1);
    if (c.ok) {
      expect(doc.status).toBe("cancelled");
      expect(startMs()).toBe(at("09:00").getTime());
      expect(doc.publicTokenHash).toBe(HASH);
    } else {
      expect(doc.status).toBe("scheduled");
      expect(startMs()).toBe(at("10:00").getTime());
      expect(doc.publicTokenHash).not.toBe(HASH);
    }
  }

  it("a cancel that commits mid-reschedule makes the reschedule re-read and refuse", async () => {
    let cancelling: ReturnType<typeof cancel> | null = null;
    // The cancel starts after the reschedule's transaction has read the
    // event, and commits while it is still checking availability.
    const r = await moveTo("10:00", "10:30", (e) => {
      cancelling ??= cancel();
      return byToken(e);
    });
    const c = await cancelling!;
    expect(r).toMatchObject({ ok: false, code: "bad_state" });
    expectConsistent(c, r);
  });

  it("two moves on one link into different free slots: one moves it, the other's link is dead", async () => {
    const [a, b] = await Promise.all([moveTo("10:00", "10:30"), moveTo("11:00", "11:30")]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const won = a.ok ? a : b.ok ? b : null;
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, code: "invalid" });
    expect(startMs()).toBe(won!.newStart.getTime());
    expect(mem.read("events/e1")).toMatchObject({ publicTokenHash: expect.not.stringMatching(HASH), rescheduleCount: 1 });
  });

  it("started together, they settle on one outcome", async () => {
    const [c, r] = await Promise.all([cancel(), moveTo("10:00", "10:30")]);
    expectConsistent(c, r);
  });

  it("with the agent's guard (the contact owns it) the later one acts on the committed state", async () => {
    const owner = (e: { contactId?: string | null }) => e.contactId === "c1";
    let cancelling: ReturnType<typeof cancel> | null = null;
    const r = await moveTo("10:00", "10:30", (e) => {
      cancelling ??= cancel(owner);
      return owner(e);
    });
    const c = await cancelling!;
    expect(c.ok).toBe(true);
    expect(r).toMatchObject({ ok: false, code: "bad_state" });
    expect(mem.read("events/e1")?.status).toBe("cancelled");
    expect(startMs()).toBe(at("09:00").getTime());
  });
});
