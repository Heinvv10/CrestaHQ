import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Google Meet bookings whose link is made or stored by the push AFTER the
 * booking: mark-paid pushes (within the deadline) BEFORE its confirmation
 * and mails the link it got, or says the link will follow and leaves a
 * timeline row; a reschedule mails the link as it stands after its push.
 * Real services → real sendEmail; the SMTP wire and Google are faked.
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
const g = vi.hoisted(() => ({
  order: [] as string[],
  within: vi.fn(async (_id: string): Promise<{ meetUrl: string | null }> => ({ meetUrl: null })),
  push: vi.fn(async (_id: string) => undefined),
}));
vi.mock("@/lib/google-calendar/push", () => ({
  pushBookingAndGetMeetUrlWithin: async (id: string) => (g.order.push("push-within"), g.within(id)),
  pushBookingToGoogle: async (id: string) => (g.order.push("push"), g.push(id)),
}));
vi.mock("@/lib/google-calendar/busy", () => ({ loadGoogleBusyForEvent: async () => [] }));

const { SA, AGENCY, mem, resetSeam, smtpSend } = await s();
const { markBookingPaidServerSide } = await import("@/lib/server/bookings-service");
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

const MEET_PAGE = { location: { type: "google_meet", value: null }, googleMeet: true, hosts: [{ uid: "h", name: "H" }] };

function seed(page: Record<string, unknown> = MEET_PAGE, event: Record<string, unknown> = {}) {
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
    ...page,
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
    meetingUrl: null,
    location: "Google Meet video call",
    ...event,
  });
}

beforeEach(() => {
  resetSeam();
  smtpSend.mockImplementation(async () => (g.order.push("email"), { id: "<sent@tenant.test>" }));
  g.order.length = 0;
  g.within.mockReset();
  g.within.mockResolvedValue({ meetUrl: null });
  g.push.mockReset();
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-not-a-real-key";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  mem.seed("contacts/c1", { name: "Thandi", email: "thandi@example.co.za", agencyId: AGENCY, subAccountId: SA });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const paid = () => markBookingPaidServerSide({ eventId: "e1", expectSubAccountId: SA, paidByUid: null });

describe("mark-paid on a Google Meet page", () => {
  it("pushes first, then mails the link the push returned (text and invite), and does not push twice", async () => {
    seed();
    g.within.mockResolvedValueOnce({ meetUrl: MEET_LINK });
    expect((await paid()).ok).toBe(true);
    expect(g.within).toHaveBeenCalledWith("e1");
    expect(g.order).toEqual(["push-within", "email"]);
    const [m] = mails();
    expect(m.text).toContain(`Join the meeting: ${MEET_LINK}`);
    expect(invite(m)).toContain(`LOCATION:${MEET_LINK}`);
    expect(mem.list("contacts/c1/activities").filter((a) => a.type === "meet_link_missing")).toEqual([]);
  });

  it("no link in time and no fallback: the mail says it will follow, and the timeline says one is owed", async () => {
    seed();
    expect((await paid()).ok).toBe(true);
    const [m] = mails();
    expect(m.text).not.toContain("Join the meeting");
    expect(m.text).toContain("Where: Google Meet video call (the joining link will follow)");
    expect(mem.list("contacts/c1/activities")).toEqual([
      expect.objectContaining({ type: "meet_link_missing", meta: { eventId: "e1" } }),
    ]);
  });

  it("no new link, but the event already holds one (made at hold time): that one goes out", async () => {
    seed(MEET_PAGE, { meetingUrl: MEET_LINK });
    expect((await paid()).ok).toBe(true);
    expect(mails()[0].text).toContain(`Join the meeting: ${MEET_LINK}`);
  });
});

it("mark-paid on any other page: confirmation first, then the usual push", async () => {
  seed({ location: { type: "in_person", value: "12 Main Rd" }, googleMeet: false }, { location: "12 Main Rd" });
  expect((await paid()).ok).toBe(true);
  expect(g.within).not.toHaveBeenCalled();
  expect(g.order).toEqual(["email", "push"]);
});

it("a reschedule mails the link as it stands after its push", async () => {
  seed(MEET_PAGE, { status: "scheduled" });
  g.push.mockImplementation(async () => {
    mem.seed("events/e1", { ...(mem.read("events/e1") as object), meetingUrl: MEET_LINK });
  });
  const again = slotAt(5, 11);
  const op = await rescheduleWithoutAvailabilityCheck("e1", again.startAt, again.endAt);
  expect(op.event.meetingUrl).toBeNull();
  await runRescheduleSideEffects({
    event: op.event,
    page: op.page,
    newRawToken: op.newToken,
    publicEventUrl: "",
    startAt: again.startAt,
    endAt: again.endAt,
    actor: "operator",
  });
  const [m] = mails();
  expect(m.text).toContain(`Join the meeting: ${MEET_LINK}`);
  expect(invite(m)).toContain(`LOCATION:${MEET_LINK}`);
});
