import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A booking's meeting link and location reach the booker in every later
 * email: the paid confirmation and the reschedule "Updated:" mail, text and
 * invite. A Google Meet link stays the same across a reschedule (the push
 * only moves the Google event — push.meet.test.ts), so it is read from the
 * event. Real routes → real sendEmail; only the SMTP wire is faked.
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
const MEET_LINK = "https://meet.google.com/abc-defg-hij";
type Wire = { text: string; html: string; attachments?: { content: string }[] };
const mails = () => smtpSend.mock.calls.map(([, m]) => m as unknown as Wire);
const invite = (m: Wire) => Buffer.from(m.attachments?.[0]?.content ?? "", "base64").toString();

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
    meetingUrl: MEET_LINK,
    location: "Google Meet video call",
  });
  mem.seed("contacts/c1", { name: "Thandi", email: "thandi@example.co.za", agencyId: AGENCY, subAccountId: SA });
});

describe("the booking's link and location", () => {
  it("are in the paid confirmation and both reschedule mails, text and invite", async () => {
    const paid = await markBookingPaidServerSide({ eventId: "e1", expectSubAccountId: SA, paidByUid: null });
    expect(paid.ok).toBe(true);
    const token = paid.ok ? paid.publicEventUrl.split("/e/")[1] ?? "" : "";

    const moved = slotAt(4, 10);
    const res = await visitorReschedule(
      new Request("http://x/api", {
        method: "POST",
        body: JSON.stringify({ slot: { startAt: moved.startAt.toISOString(), endAt: moved.endAt.toISOString() } }),
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

    const sent = mails();
    expect(sent).toHaveLength(3);
    for (const m of sent) {
      expect(m.text).toContain(`Join the meeting: ${MEET_LINK}`);
      expect(m.text).toContain("Where: Google Meet video call");
      expect(invite(m)).toContain(`LOCATION:${MEET_LINK}`);
    }
    expect(mem.read("events/e1")).toMatchObject({ meetingUrl: MEET_LINK });
  });
});
