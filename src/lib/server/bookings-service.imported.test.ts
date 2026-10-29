import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * markBookingPaidServerSide — the one write behind the Mark paid button, the
 * agent's mark_booking_paid and the Stripe/Paystack reconcilers — never
 * confirms an event imported from a member's Google Calendar, even one that
 * looks exactly like a held booking. Nothing is written, nothing is sent.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
const lifecycle = vi.hoisted(() => ({ scheduleEventReminders: vi.fn(async () => undefined) }));
vi.mock("@/lib/booking/lifecycle", async () => ({ ...(await h()).bookingMocks.lifecycle(), ...lifecycle }));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: async () => undefined }));

const { SA, mem, resetBookingHarness, seedEvent, seedPage } = await h();
const { markBookingPaidServerSide } = await import("./bookings-service");

const held = (source: string) =>
  seedEvent("e1", "10:00", "10:30", {
    source,
    status: "awaiting_payment",
    bookingPageSlug: "p",
    publicTokenHash: "h0",
    paymentRequired: true,
  });

beforeEach(() => {
  resetBookingHarness();
  lifecycle.scheduleEventReminders.mockClear();
  seedPage("p");
});
afterEach(() => vi.useRealTimers());

it("refuses an imported Google event: not found, untouched, nothing scheduled", async () => {
  held("google");
  expect(await markBookingPaidServerSide({ eventId: "e1", expectSubAccountId: SA, paidByUid: "u1" })).toMatchObject({
    ok: false,
    code: "not_found",
  });
  expect(mem.read("events/e1")).toMatchObject({ status: "awaiting_payment", publicTokenHash: "h0" });
  expect(lifecycle.scheduleEventReminders).not.toHaveBeenCalled();
});

it("confirms the same held booking (control)", async () => {
  held("booking_page");
  expect(await markBookingPaidServerSide({ eventId: "e1", expectSubAccountId: SA, paidByUid: "u1" })).toMatchObject({
    ok: true,
  });
  expect(mem.read("events/e1")?.status).toBe("scheduled");
});
