import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";
import { SA, mem, post, resetBookingHarness, seedPage, slot } from "@/test/booking-harness";

/**
 * The booking confirmation text through the real book route: real route ->
 * real sendBookingSms -> real sendSmsForSubAccount (quiet hours) over the
 * booking harness's in-memory Firestore. The harness clock is Mon 06:00Z; the
 * sub-account's send window is 08:00-20:00 UTC, so the booking is made in
 * quiet hours.
 */

const sendSmsVia = vi.fn();
const scheduleEventReminders = vi.fn();

const h = () => import("@/test/booking-harness");
const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());
vi.mock("@/lib/booking/lifecycle", async () => ({
  ...(await h()).bookingMocks.lifecycle(),
  scheduleEventReminders: (...a: unknown[]) => scheduleEventReminders(...a),
}));
vi.mock("@/lib/comms/smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/comms/sms/select", () => ({ sendSmsVia: (...a: unknown[]) => sendSmsVia(...a) }));
vi.mock("@/lib/server/sub-account-secrets", () => ({ readSubAccountSecret: async () => "token" }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));
vi.mock("@/lib/google-calendar/push", () => ({
  pushBookingToGoogleAfterResponse: () => undefined,
  pushBookingAndGetMeetUrlWithin: async () => ({ meetUrl: null, pending: false }),
}));

const { SMTP_SUB } = await s();
const { POST } = await import("./route");

const book = () =>
  POST(post({ name: "Visitor Vee", email: "v@example.com", phone: "+27600000000", slot: slot("09:00", "09:30") }), {
    params: Promise.resolve({ saId: SA, slug: "intro" }),
  });

const texts = () => sendSmsVia.mock.calls.map((c) => (c[1] as { to: string; body: string }));

beforeEach(() => {
  resetBookingHarness();
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  sendSmsVia.mockReset().mockResolvedValue({ sid: "SM1" });
  scheduleEventReminders.mockReset().mockResolvedValue(undefined);
  mem.seed(`subAccounts/${SA}`, {
    ...SMTP_SUB,
    agencyId: "ag1",
    sendWindow: { startHour: 8, endHour: 20, timezone: "UTC" },
    twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27110000000" },
  });
  mem.seed("contacts/c1", { name: "Visitor Vee", phone: "+27600000000", agencyId: "ag1", subAccountId: SA });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe("the confirmation text", () => {
  it("is not sent when the page's text toggle is off (the default)", async () => {
    seedPage("intro");
    expect((await book()).status).toBe(200);
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
  });

  it("is sent for a booking the customer just made, even in quiet hours", async () => {
    seedPage("intro", { smsRemindersEnabled: true });
    expect((await book()).status).toBe(200);
    await flushAfterResponse();
    expect(texts()).toHaveLength(1);
    expect(texts()[0].to).toBe("+27600000000");
    expect(texts()[0].body).toContain("Hi Visitor, you're booked: intro with Fixture Co");
    expect(texts()[0].body).toContain("https://app.test/e/");
  });

  it("is not sent to a contact who opted out of SMS; the booking still succeeds", async () => {
    seedPage("intro", { smsRemindersEnabled: true });
    mem.seed("contacts/c1", { name: "Visitor Vee", phone: "+27600000000", smsOptedOut: true, agencyId: "ag1", subAccountId: SA });
    expect((await book()).status).toBe(200);
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(mem.list("events")).toHaveLength(1);
  });

  it("is not sent for an unpaid hold (it goes with the mark-paid confirmation)", async () => {
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`), paypalConfig: { username: "fixture" } });
    seedPage("intro", {
      smsRemindersEnabled: true,
      payment: { amount: 50, currency: "USD", description: null, holdHours: 24 },
    });
    expect((await book()).status).toBe(200);
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
  });
});

describe("reminder scheduling", () => {
  it("is scheduled for a text-only page, carrying the page so the step knows the channels", async () => {
    seedPage("intro", { remindersEnabled: false, smsRemindersEnabled: true, reminderOffsetsMinutes: [60] });
    expect((await book()).status).toBe(200);
    expect(scheduleEventReminders).toHaveBeenCalledOnce();
    expect(scheduleEventReminders.mock.calls[0][0]).toMatchObject({
      reminderOffsetsMinutes: [60],
      page: expect.objectContaining({ smsRemindersEnabled: true, remindersEnabled: false }),
    });
  });

  it("is not scheduled when both channels are off", async () => {
    seedPage("intro", { remindersEnabled: false, smsRemindersEnabled: false, reminderOffsetsMinutes: [60] });
    expect((await book()).status).toBe(200);
    expect(scheduleEventReminders).not.toHaveBeenCalled();
  });
});
