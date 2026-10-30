import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * An agent-approved mark-paid sends NO text reminders: the approver reviewed
 * the email address, not the phone. Driven end to end with nothing in the
 * middle mocked: the real mark-paid, the real scheduleEventReminders (QStash is
 * a spy that records what it was asked to publish), and the real reminder step
 * fed with exactly that published body. The operator's own mark-paid is the
 * control: the same page and contact DO get their text.
 */

const sendSmsVia = vi.fn();
const publishCallback = vi.fn();

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/automations/qstash", () => ({
  verifyQStashSignature: async () => true,
  qstashIsConfigured: () => true,
  publishCallback: (...a: unknown[]) => publishCallback(...a),
}));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: async () => undefined }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/booking/lifecycle", async (orig) => ({
  ...(await orig<typeof import("@/lib/booking/lifecycle")>()),
  fireBookingTrigger: async () => undefined,
  recordBookingActivity: async () => undefined,
}));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: async () => undefined }));
vi.mock("@/lib/comms/sms/select", () => ({ sendSmsVia: (...a: unknown[]) => sendSmsVia(...a) }));
vi.mock("@/lib/server/sub-account-secrets", () => ({ readSubAccountSecret: async () => "token" }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));

const { SA, AGENCY, SMTP_SUB, mem, resetSeam, smtpSend } = await s();
const { markBookingPaidServerSide } = await import("./bookings-service");
const { POST: reminderStep } = await import("@/app/api/events/reminder/step/route");

const DAY = new Date("2026-09-24T10:00:00Z");
const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });
const AGENT = { contactId: "c1", emailTo: "thandi@example.co.za", stepsFingerprints: {} };

const markPaid = (agent: boolean) =>
  markBookingPaidServerSide({ eventId: "e1", expectSubAccountId: SA, paidByUid: "admin1", ...(agent ? { expect: AGENT } : {}) });
const seedPage = (over: Record<string, unknown> = {}) =>
  mem.seed(`subAccounts/${SA}/bookingPages/p1`, {
    name: "Intro call",
    timezone: "UTC",
    durationMinutes: 30,
    remindersEnabled: true,
    smsRemindersEnabled: true,
    reminderOffsetsMinutes: [60],
    ...over,
  });
/** The body QStash was asked to deliver, run through the real step. */
const runPublishedSteps = async () => {
  const bodies = publishCallback.mock.calls.map((c) => (c[0] as { body: unknown }).body);
  for (const body of bodies) {
    const res = await reminderStep(
      new Request("https://app.test/api/events/reminder/step", { method: "POST", headers: { "Upstash-Signature": "sig" }, body: JSON.stringify(body) }),
    );
    expect(res.status).toBe(200);
  }
  await flushAfterResponse();
  return bodies as Array<{ channels?: { email?: boolean; sms?: boolean } }>;
};

beforeEach(() => {
  resetSeam();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DAY);
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-not-a-real-key";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  sendSmsVia.mockReset().mockResolvedValue({ sid: "SM1" });
  publishCallback.mockReset().mockResolvedValue({ messageId: "m1" });
  mem.seed(`subAccounts/${SA}`, {
    ...SMTP_SUB,
    defaultPhoneCountry: "ZA",
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
  mem.seed("contacts/c1", { name: "Thandi", email: "thandi@example.co.za", phone: "+27821234567", agencyId: AGENCY, subAccountId: SA });
});
afterEach(() => vi.useRealTimers());

describe("an agent-approved mark-paid", () => {
  it("schedules email reminders only, and the real step sends no text", async () => {
    seedPage();
    expect(await markPaid(true)).toMatchObject({ ok: true });
    const bodies = await runPublishedSteps();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].channels).toMatchObject({ email: true, sms: false });
    expect(sendSmsVia).not.toHaveBeenCalled();
    // The email reminder (and the confirmation email) still go.
    expect(smtpSend).toHaveBeenCalledTimes(2);
  });

  it("on a text-only page schedules nothing at all", async () => {
    seedPage({ remindersEnabled: false });
    await markPaid(true);
    expect(publishCallback).not.toHaveBeenCalled();
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
  });

  it("cannot be talked into texting by a live page edit between scheduling and the step", async () => {
    seedPage({ smsRemindersEnabled: false });
    await markPaid(true);
    seedPage({ smsRemindersEnabled: true });
    await runPublishedSteps();
    expect(sendSmsVia).not.toHaveBeenCalled();
  });
});

describe("the operator's own mark-paid (control)", () => {
  it("schedules both channels, and the real step texts", async () => {
    seedPage();
    expect(await markPaid(false)).toMatchObject({ ok: true });
    const bodies = await runPublishedSteps();
    expect(bodies[0].channels).toMatchObject({ email: true, sms: true });
    expect(sendSmsVia).toHaveBeenCalledTimes(2); // the confirmation, then the reminder
  });
});
