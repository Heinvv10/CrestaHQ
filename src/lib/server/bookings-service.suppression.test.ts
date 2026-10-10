import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * Paid-booking confirmation against the suppression list: real mark-paid →
 * real sendEmail → real lookup. A suppressed address is recorded on the
 * contact's timeline once, and the no-ICS retry is not attempted.
 */

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/booking/lifecycle", () => ({
  fireBookingTrigger: async () => undefined,
  recordBookingActivity: async () => undefined,
  scheduleEventReminders: async () => undefined,
}));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: async () => undefined }));

const { SA, AGENCY, mem, resetSeam, smtpSend, suppress, wireRecipients } = await s();
const { markBookingPaidServerSide } = await import("./bookings-service");

const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });
const markPaid = () => markBookingPaidServerSide({ eventId: "e1", expectSubAccountId: SA, paidByUid: "admin1" });

beforeEach(() => {
  resetSeam();
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-not-a-real-key";
  const start = new Date(Date.now() + 24 * 3600_000);
  mem.seed("events/e1", {
    agencyId: AGENCY,
    subAccountId: SA,
    status: "awaiting_payment",
    title: "Intro",
    contactId: "c1",
    startAt: ts(start),
    endAt: ts(new Date(start.getTime() + 1800_000)),
  });
  mem.seed("contacts/c1", { name: "Thandi", email: "thandi@example.co.za", agencyId: AGENCY, subAccountId: SA });
});

describe("paid booking confirmation", () => {
  it("is sent to an address that is not suppressed, with no activity", async () => {
    expect(await markPaid()).toMatchObject({ ok: true });
    expect(wireRecipients()).toEqual(["thandi@example.co.za"]);
    expect(mem.list("contacts/c1/activities")).toEqual([]);
  });

  it("is refused once for a suppressed contact and recorded on their timeline", async () => {
    suppress("thandi@example.co.za");
    const suppressionReads = vi.spyOn(mem.db, "doc");
    expect(await markPaid()).toMatchObject({ ok: true });
    await flushAfterResponse();
    expect(smtpSend).not.toHaveBeenCalled();
    // One suppression lookup: the ICS-less retry is skipped, not re-refused.
    expect(suppressionReads.mock.calls.filter(([p]) => String(p).includes("/emailSuppressions/"))).toHaveLength(1);
    suppressionReads.mockRestore();
    expect(mem.list("contacts/c1/activities")).toEqual([
      expect.objectContaining({
        type: "email_suppressed",
        content: expect.stringContaining("Booking confirmation not sent"),
        meta: expect.objectContaining({ eventId: "e1" }),
      }),
    ]);
  });
});
