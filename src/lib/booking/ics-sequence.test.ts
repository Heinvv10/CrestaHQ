import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every invite update for one booking carries a higher SEQUENCE than the
 * last, or calendar apps ignore it as stale. Mark-paid and both reschedule
 * paths all sent SEQUENCE:1, so a second change never reached the visitor's
 * calendar. Real routes → real sendEmail; only the SMTP wire is faked.
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
vi.mock("@/lib/google-calendar/busy", () => ({ loadGoogleBusyForEvent: async () => [] }));

const { SA, AGENCY, mem, resetSeam, smtpSend } = await s();
const { markBookingPaidServerSide } = await import("@/lib/server/bookings-service");
const { POST: visitorReschedule } = await import("@/app/api/events/[token]/reschedule/route");
const { rescheduleWithoutAvailabilityCheck, runRescheduleSideEffects } = await import("./reschedule");

const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });
const HOUR = 3600_000;
/** A 30-minute slot on the half-hour grid, `days` ahead. */
function slotAt(days: number, hour: number) {
  const d = new Date(Date.now() + days * 24 * HOUR);
  d.setUTCHours(hour, 0, 0, 0);
  return { startAt: d, endAt: new Date(d.getTime() + HOUR / 2) };
}
/** SEQUENCE of every ICS the wire carried, in send order. */
const sequences = () =>
  smtpSend.mock.calls.flatMap(([, m]) =>
    ((m as { attachments?: { content: string }[] }).attachments ?? []).map((a) =>
      Number(/SEQUENCE:(\d+)/.exec(Buffer.from(a.content, "base64").toString())?.[1]),
    ),
  );

beforeEach(() => {
  resetSeam();
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-not-a-real-key";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  mem.seed(`subAccounts/${SA}/bookingPages/p`, {
    slug: "p",
    name: "Intro",
    status: "published",
    durationMinutes: 30,
    bufferMinutes: 0,
    workingHours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startMinute: 0, endMinute: 1440 })),
    timezone: "UTC",
    visibleDays: 14,
    minNoticeHours: 0,
    maxPerDay: null,
    remindersEnabled: false,
    reminderOffsetsMinutes: [],
    agencyId: AGENCY,
    subAccountId: SA,
  });
  const first = slotAt(3, 9);
  mem.seed("events/e1", {
    agencyId: AGENCY,
    subAccountId: SA,
    status: "awaiting_payment",
    title: "Intro",
    contactId: "c1",
    bookingPageSlug: "p",
    source: "booking_page",
    startAt: ts(first.startAt),
    endAt: ts(first.endAt),
  });
  mem.seed("contacts/c1", { name: "Thandi", email: "thandi@example.co.za", agencyId: AGENCY, subAccountId: SA });
});

describe("ICS SEQUENCE", () => {
  it("rises with every update: paid, visitor reschedule, operator reschedule", async () => {
    const paid = await markBookingPaidServerSide({ eventId: "e1", expectSubAccountId: SA, paidByUid: null });
    expect(paid.ok).toBe(true);
    const token = paid.ok ? paid.publicEventUrl.split("/e/")[1] ?? "" : "";

    const moved = slotAt(4, 10);
    const res = await visitorReschedule(
      new Request("http://x/api", {
        method: "POST",
        body: JSON.stringify({
          slot: { startAt: moved.startAt.toISOString(), endAt: moved.endAt.toISOString() },
        }),
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(200);

    const again = slotAt(5, 11);
    const op = await rescheduleWithoutAvailabilityCheck("e1", again.startAt, again.endAt);
    await runRescheduleSideEffects({
      event: op.event,
      page: op.page,
      newRawToken: op.newToken,
      publicEventUrl: "",
      startAt: again.startAt,
      endAt: again.endAt,
      actor: "operator",
    });

    const seq = sequences();
    expect(seq).toHaveLength(3);
    expect(seq[1]).toBeGreaterThan(seq[0]);
    expect(seq[2]).toBeGreaterThan(seq[1]);
  });
});
