import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";
import { NOW, SA, mem, post, resetBookingHarness, seedPage, slot } from "@/test/booking-harness";

/**
 * The booking confirmation text through the real book route: real route ->
 * real sendBookingSms -> real sendSmsForSubAccount (quiet hours) over the
 * booking harness's in-memory Firestore. The harness clock is Mon 06:00Z; the
 * sub-account's send window is 08:00-20:00 UTC, so the booking is made in
 * quiet hours.
 */

const sendSmsVia = vi.fn();
const scheduleEventReminders = vi.fn();
const order: string[] = [];
/** `after()` callbacks, held back (when `on`) so a test can run them later, as the host does after the response. */
const deferred = vi.hoisted(() => ({ on: false, fns: [] as Array<() => unknown> }));

const h = () => import("@/test/booking-harness");
const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());
vi.mock("@/lib/booking/lifecycle", async () => ({
  ...(await h()).bookingMocks.lifecycle(),
  scheduleEventReminders: async (...a: unknown[]) => (order.push("reminders"), scheduleEventReminders(...a)),
  recordBookingActivity: async () => void order.push("activity"),
  fireBookingTrigger: async () => void order.push("trigger"),
}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    if (!deferred.on) throw new Error("outside a request scope");
    deferred.fns.push(fn);
  },
}));
vi.mock("@/lib/comms/smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/comms/sms/select", () => ({ sendSmsVia: async (...a: unknown[]) => (order.push("sms"), sendSmsVia(...a)) }));
vi.mock("@/lib/server/sub-account-secrets", () => ({ readSubAccountSecret: async () => "token" }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));
vi.mock("@/lib/google-calendar/push", () => ({
  pushBookingToGoogleAfterResponse: () => undefined,
  pushBookingAndGetMeetUrlWithin: async () => ({ meetUrl: null, pending: false }),
}));

const { SMTP_SUB } = await s();
const { POST } = await import("./route");

const book = () =>
  POST(post({ name: "Visitor Vee", email: "v@example.com", phone: "+27821234567", slot: slot("09:00", "09:30") }), {
    params: Promise.resolve({ saId: SA, slug: "intro" }),
  });

const texts = () => sendSmsVia.mock.calls.map((c) => (c[1] as { to: string; body: string }));

beforeEach(() => {
  resetBookingHarness();
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  sendSmsVia.mockReset().mockResolvedValue({ sid: "SM1" });
  scheduleEventReminders.mockReset().mockResolvedValue(undefined);
  order.length = 0;
  deferred.on = false;
  deferred.fns.length = 0;
  mem.seed(`subAccounts/${SA}`, {
    ...SMTP_SUB,
    agencyId: "ag1",
    defaultPhoneCountry: "ZA",
    sendWindow: { startHour: 8, endHour: 20, timezone: "UTC" },
    twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27110000000" },
  });
  mem.seed("contacts/c1", { name: "Visitor Vee", phone: "+27821234567", agencyId: "ag1", subAccountId: SA });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  deferred.on = false;
  vi.useRealTimers();
});

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
    expect(texts()[0].to).toBe("+27821234567");
    expect(texts()[0].body).toContain("Hi Visitor, you're booked: intro with Fixture Co");
    expect(texts()[0].body).toContain("https://app.test/e/");
  });

  it("is claimed and counted against the daily caps in one step", async () => {
    seedPage("intro", { smsRemindersEnabled: true });
    expect((await book()).status).toBe(200);
    await flushAfterResponse();
    const [event] = mem.list("events");
    expect(mem.read(`events/${event.id}/reminderSends/sms_confirm`)).toBeTruthy();
    expect(mem.list(`subAccounts/${SA}/bookingSmsCaps`).map((d) => d.count)).toEqual([1, 1]);
  });

  it("is not sent to a contact who opted out of SMS; the booking still succeeds", async () => {
    seedPage("intro", { smsRemindersEnabled: true });
    mem.seed("contacts/c1", { name: "Visitor Vee", phone: "+27821234567", smsOptedOut: true, agencyId: "ag1", subAccountId: SA });
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

/** Runs what the host would run after the response, and waits for it. */
const runAfter = async () => {
  for (const fn of deferred.fns.splice(0)) await fn();
  await flushAfterResponse();
};
const MINUTE = 60_000;

describe("the confirmation text runs after the response", () => {
  it("does not hold up the response: nothing is sent until the host runs the after-callbacks, and then it goes", async () => {
    deferred.on = true;
    seedPage("intro", { smsRemindersEnabled: true });
    expect((await book()).status).toBe(200);
    expect(sendSmsVia).not.toHaveBeenCalled();
    await runAfter();
    expect(sendSmsVia).toHaveBeenCalledOnce();
  });

  it("goes after the reminders are scheduled, the activity row and the booking triggers", async () => {
    seedPage("intro", { smsRemindersEnabled: true, reminderOffsetsMinutes: [60] });
    expect((await book()).status).toBe(200);
    await flushAfterResponse();
    expect(order.indexOf("sms")).toBeGreaterThan(-1);
    for (const earlier of ["reminders", "activity", "trigger"]) {
      expect(order.indexOf(earlier), earlier).toBeGreaterThan(-1);
      expect(order.indexOf(earlier), earlier).toBeLessThan(order.indexOf("sms"));
    }
  });

  it("is still exempt from quiet hours when it runs a couple of minutes after the booking", async () => {
    deferred.on = true;
    seedPage("intro", { smsRemindersEnabled: true });
    expect((await book()).status).toBe(200);
    vi.setSystemTime(new Date(NOW.getTime() + 2 * MINUTE));
    await runAfter();
    expect(texts()).toHaveLength(1);
  });

  it("is held, and says so on the contact's timeline, if it only runs after the exemption has lapsed", async () => {
    deferred.on = true;
    seedPage("intro", { smsRemindersEnabled: true });
    expect((await book()).status).toBe(200);
    vi.setSystemTime(new Date(NOW.getTime() + 11 * MINUTE));
    await runAfter();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(mem.list("contacts/c1/activities")).toEqual([
      expect.objectContaining({ type: "quiet_hours_held", content: expect.stringContaining("Booking confirmation text was not sent: it fell in quiet hours") }),
    ]);
  });

  it("leaves a note when it cannot be sent at all (the contact has no phone)", async () => {
    seedPage("intro", { smsRemindersEnabled: true });
    mem.seed("contacts/c1", { name: "Visitor Vee", agencyId: "ag1", subAccountId: SA });
    expect((await book()).status).toBe(200);
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(mem.list("contacts/c1/activities")).toEqual([
      expect.objectContaining({ content: "Booking confirmation text not sent: the contact has no phone number." }),
    ]);
  });
});

describe("what the booker typed", () => {
  const HOSTILE = "https://evil.example/pay-now";

  it("never reaches the text: not the address they gave, nor the phone, nor a URL in their name", async () => {
    seedPage("intro", { smsRemindersEnabled: true, location: { type: "their_address", value: null } });
    mem.seed("contacts/c1", { name: HOSTILE, phone: "+27821234567", agencyId: "ag1", subAccountId: SA });
    const res = await POST(
      post({ name: HOSTILE, email: "v@example.com", phone: "+27821234567", address: "7 Oak Ave, call 0861234567 now", slot: slot("09:00", "09:30") }),
      { params: Promise.resolve({ saId: SA, slug: "intro" }) },
    );
    expect(res.status).toBe(200);
    expect(mem.list("events")[0].location).toContain("7 Oak Ave");
    await flushAfterResponse();
    expect(texts()).toHaveLength(1);
    const body = texts()[0].body;
    expect(body).not.toContain("evil");
    expect(body).not.toContain("Oak");
    expect(body).not.toContain("0861234567");
    expect(body).not.toContain("27821234567");
    expect(body).not.toContain("Where");
    expect(body.split("\n")).toEqual([
      expect.stringMatching(/^You're booked: intro with Fixture Co, /),
      expect.stringMatching(/^Reschedule or cancel: https:\/\/app\.test\/e\//),
    ]);
  });

  it("a number outside the workspace's home country gets no text, and the booking still succeeds", async () => {
    seedPage("intro", { smsRemindersEnabled: true });
    mem.seed("contacts/c1", { name: "Visitor Vee", phone: "+14155552671", agencyId: "ag1", subAccountId: SA });
    expect((await book()).status).toBe(200);
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(mem.list("events")).toHaveLength(1);
    expect(mem.list("contacts/c1/activities")).toEqual([expect.objectContaining({ content: expect.stringContaining("home country") })]);
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
