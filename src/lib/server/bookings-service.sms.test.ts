import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * The paid-booking confirmation text through the real mark-paid: real
 * runMarkPaidSideEffects -> real sendBookingSms -> real sendSmsForSubAccount
 * over an in-memory Firestore. 21:00Z = 23:00 SAST, outside the 08:00-20:00
 * window. Mark-paid is the operator's (or the agent's, approved) click, not
 * the customer's own booking, so quiet hours hold its text.
 */

const sendSmsVia = vi.fn();
const scheduleEventReminders = vi.fn();

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/booking/lifecycle", () => ({
  fireBookingTrigger: async () => undefined,
  recordBookingActivity: async () => undefined,
  scheduleEventReminders: (...a: unknown[]) => scheduleEventReminders(...a),
}));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: async () => undefined }));
vi.mock("@/lib/comms/sms/select", () => ({ sendSmsVia: (...a: unknown[]) => sendSmsVia(...a) }));
vi.mock("@/lib/server/sub-account-secrets", () => ({ readSubAccountSecret: async () => "token" }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));

const { SA, AGENCY, SMTP_SUB, mem, resetSeam, smtpSend, wireRecipients } = await s();
const { markBookingPaidServerSide } = await import("./bookings-service");

const DAY = new Date("2026-09-24T10:00:00Z");
const NIGHT = new Date("2026-09-24T21:00:00Z");
const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });

const markPaid = (expect_?: { contactId: string | null; emailTo: string | null; stepsFingerprints: Record<string, string> }) =>
  markBookingPaidServerSide({ eventId: "e1", expectSubAccountId: SA, paidByUid: "admin1", ...(expect_ ? { expect: expect_ } : {}) });
const texts = () => sendSmsVia.mock.calls.map((c) => c[1] as { to: string; body: string });
const seedPage = (over: Record<string, unknown> = {}) =>
  mem.seed(`subAccounts/${SA}/bookingPages/p1`, {
    name: "Intro call",
    timezone: "UTC",
    durationMinutes: 30,
    remindersEnabled: false,
    smsRemindersEnabled: true,
    reminderOffsetsMinutes: [60],
    ...over,
  });
const seedContact = (over: Record<string, unknown> = {}) =>
  mem.seed("contacts/c1", {
    name: "Thandi",
    email: "thandi@example.co.za",
    phone: "+27821234567",
    agencyId: AGENCY,
    subAccountId: SA,
    ...over,
  });

beforeEach(() => {
  resetSeam();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DAY);
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-not-a-real-key";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  sendSmsVia.mockReset().mockResolvedValue({ sid: "SM1" });
  scheduleEventReminders.mockReset().mockResolvedValue(undefined);
  mem.seed(`subAccounts/${SA}`, {
    ...SMTP_SUB,
    sendWindow: { startHour: 8, endHour: 20, timezone: "Africa/Johannesburg" },
    twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27110000000" },
  });
  const start = new Date(Date.now() + 24 * 3600_000);
  mem.seed("events/e1", {
    agencyId: AGENCY,
    subAccountId: SA,
    status: "awaiting_payment",
    title: "Intro",
    contactId: "c1",
    bookingPageSlug: "p1",
    startAt: ts(start),
    endAt: ts(new Date(start.getTime() + 1800_000)),
  });
  seedPage();
  seedContact();
});
afterEach(() => vi.useRealTimers());

describe("the mark-paid confirmation text", () => {
  it("is sent with the email when the page's text toggle is on", async () => {
    expect(await markPaid()).toMatchObject({ ok: true });
    await flushAfterResponse();
    expect(texts()).toHaveLength(1);
    expect(texts()[0].to).toBe("+27821234567");
    expect(texts()[0].body).toContain("Hi Thandi, you're booked: Intro call with Fixture Co");
    expect(texts()[0].body).toContain("https://app.test/e/");
    expect(wireRecipients()).toEqual(["thandi@example.co.za"]);
  });

  it("is not sent when the toggle is off (the default)", async () => {
    seedPage({ smsRemindersEnabled: undefined });
    await markPaid();
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(wireRecipients()).toEqual(["thandi@example.co.za"]);
  });

  it("is not sent to a contact who opted out of SMS; the email still goes", async () => {
    seedContact({ smsOptedOut: true });
    await markPaid();
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(wireRecipients()).toEqual(["thandi@example.co.za"]);
  });

  it("is not sent to a contact of another sub-account, and nothing is written to them", async () => {
    seedContact({ subAccountId: "other-tenant" });
    await markPaid();
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(mem.list("contacts/c1/activities")).toHaveLength(0);
    expect(mem.list("contacts/c1/messages")).toHaveLength(0);
  });

  it("is held by quiet hours (not the customer's own booking): dropped with a timeline note, the email still goes", async () => {
    vi.setSystemTime(NIGHT);
    await markPaid();
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(mem.list("contacts/c1/activities")).toEqual([
      expect.objectContaining({ type: "quiet_hours_held", content: expect.stringContaining("Booking confirmation text was not sent") }),
    ]);
    expect(wireRecipients()).toEqual(["thandi@example.co.za"]);
  });

  it("is not sent on an agent mark-paid: the approver reviewed the email address, not the phone", async () => {
    await markPaid({ contactId: "c1", emailTo: "thandi@example.co.za", stepsFingerprints: {} });
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(wireRecipients()).toEqual(["thandi@example.co.za"]);
  });

  it("is not sent when the confirmation is withheld because the recipient changed", async () => {
    await markPaid({ contactId: "c1", emailTo: "someone-else@example.co.za", stepsFingerprints: {} });
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(smtpSend).not.toHaveBeenCalled();
  });
});

describe("reminders after mark-paid", () => {
  it("are scheduled for a text-only page, carrying the page", async () => {
    await markPaid();
    expect(scheduleEventReminders).toHaveBeenCalledOnce();
    expect(scheduleEventReminders.mock.calls[0][0]).toMatchObject({
      scheduleNonce: "paid",
      page: expect.objectContaining({ smsRemindersEnabled: true, remindersEnabled: false }),
    });
  });

  it("are not scheduled when both channels are off", async () => {
    seedPage({ smsRemindersEnabled: false, remindersEnabled: false });
    await markPaid();
    expect(scheduleEventReminders).not.toHaveBeenCalled();
  });
});
