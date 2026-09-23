import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mark-paid is a compare-and-set on `awaiting_payment`. It used to read, then
 * write blind: a payment-expiry cancel landing between the two was
 * overwritten back to `scheduled` (the released slot double-booked), and a
 * webhook racing the operator's button both confirmed — two token rotations,
 * two confirmation emails, and the first reminder set dead as "rotated".
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/automations/qstash", () => ({ verifyQStashSignature: async () => true }));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: async () => undefined }));

const reminders = vi.fn(async (_input: { rawToken: string }) => undefined);
const triggers = vi.fn(async (_e: unknown, _t: string) => undefined);
vi.mock("@/lib/booking/lifecycle", async () => ({
  ...(await h()).bookingMocks.lifecycle(),
  scheduleEventReminders: (input: { rawToken: string }) => reminders(input),
  fireBookingTrigger: (e: unknown, t: string) => triggers(e, t),
}));

const { SA, mem, resetBookingHarness, seedEvent, seedPage } = await h();
const { markBookingPaidServerSide } = await import("./bookings-service");
const { POST: expire } = await import("@/app/api/events/payment/expire-step/route");
const { hashEventToken, issueEventToken } = await import("@/lib/booking/event-token");

const markPaid = (paidByUid: string | null) =>
  markBookingPaidServerSide({ eventId: "e1", expectSubAccountId: SA, paidByUid });
const runExpire = () =>
  expire(
    new Request("http://x/api/events/payment/expire-step", {
      method: "POST",
      headers: { "Upstash-Signature": "sig" },
      body: JSON.stringify({ eventId: "e1" }),
    }),
  );
const read = () => mem.read("events/e1")!;

let originalHash = "";
beforeEach(() => {
  resetBookingHarness();
  reminders.mockClear();
  triggers.mockClear();
  seedPage("p", { remindersEnabled: true, reminderOffsetsMinutes: [60] });
  originalHash = issueEventToken("e1").hash;
  seedEvent("e1", "10:00", "10:30", {
    status: "awaiting_payment",
    bookingPageSlug: "p",
    contactId: "c1",
    publicTokenHash: originalHash,
  });
});
afterEach(() => vi.useRealTimers());

describe("mark-paid against a racing payment expiry", () => {
  it("never flips a booking the expiry cancelled back to scheduled", async () => {
    const [paid] = await Promise.all([markPaid(null), runExpire()]);
    const status = read().status;
    if (status === "cancelled") {
      expect(paid).toMatchObject({ ok: false, code: "bad_status" });
      expect(triggers.mock.calls.map(([, t]) => t)).toEqual(["event_cancelled"]);
    } else {
      expect(status).toBe("scheduled");
      expect(paid).toMatchObject({ ok: true });
      expect(triggers.mock.calls.map(([, t]) => t)).toEqual(["event_paid"]);
    }
  });
});

describe("mark-paid twice at once (webhook + operator)", () => {
  it("confirms once: one rotation, one reminder set, and it carries the live token", async () => {
    const results = await Promise.all([markPaid(null), markPaid("admin1")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      expect.objectContaining({ code: "bad_status" }),
    ]);
    expect(reminders).toHaveBeenCalledTimes(1);
    expect(hashEventToken(reminders.mock.calls[0][0].rawToken)).toBe(read().publicTokenHash);
    expect(triggers.mock.calls.map(([, t]) => t)).toEqual(["event_paid"]);
  });
});

describe("mark-paid bookkeeping", () => {
  it("remembers the pre-payment link so the Stripe success page can still resolve", async () => {
    expect(await markPaid(null)).toMatchObject({ ok: true });
    expect(read().paidFromTokenHash).toBe(originalHash);
    expect(read().publicTokenHash).not.toBe(originalHash);
  });
});
