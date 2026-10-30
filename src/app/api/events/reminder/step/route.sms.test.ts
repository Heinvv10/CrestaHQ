import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * Reminder texts through the real step route: real route -> real
 * deliverReminderSms -> real sendBookingSms -> real sendSmsForSubAccount over
 * an in-memory Firestore. The carrier, QStash, usage metering, the credential
 * read and the SMTP wire are the only stubs. 21:00Z = 23:00 SAST, outside the
 * 08:00-20:00 window; the window ends at 06:00Z.
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
  publishCallback: (...a: unknown[]) => publishCallback(...a),
}));
vi.mock("@/lib/comms/sms/select", () => ({ sendSmsVia: (...a: unknown[]) => sendSmsVia(...a) }));
vi.mock("@/lib/server/sub-account-secrets", () => ({ readSubAccountSecret: async () => "token" }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));

const { SA, AGENCY, SMTP_SUB, mem, resetSeam, smtpSend } = await s();
const { POST } = await import("./route");
const { issueEventToken } = await import("@/lib/booking/event-token");
const { invalidateAgencyPolicyCache } = await import("@/lib/agency/policy");

const WINDOW = { startHour: 8, endHour: 20, timezone: "Africa/Johannesburg" };
const DAY = new Date("2026-09-24T10:00:00Z");
const NIGHT = new Date("2026-09-24T21:00:00Z");
const MORNING = new Date("2026-09-25T06:00:00Z");

const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });
let token = "";

const remind = (extra: Record<string, unknown> = {}, offsetMinutes = 60) =>
  POST(
    new Request("https://app.test/api/events/reminder/step", {
      method: "POST",
      headers: { "Upstash-Signature": "sig" },
      body: JSON.stringify({ eventId: "e1", offsetMinutes, token, ...extra }),
    }),
  );

const seedEvent = (start: Date) => {
  const issued = issueEventToken("e1");
  token = issued.token;
  mem.seed("events/e1", {
    agencyId: AGENCY,
    subAccountId: SA,
    status: "scheduled",
    title: "Intro",
    contactId: "c1",
    bookingPageSlug: "p1",
    location: "12 Long St",
    publicTokenHash: issued.hash,
    startAt: ts(start),
    endAt: ts(new Date(start.getTime() + 1800_000)),
  });
};
const seedPage = (over: Record<string, unknown> = {}) =>
  mem.seed(`subAccounts/${SA}/bookingPages/p1`, {
    name: "Intro call",
    timezone: "Africa/Johannesburg",
    durationMinutes: 30,
    remindersEnabled: false,
    smsRemindersEnabled: true,
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
const claims = () => mem.list("events/e1/reminderSends").map((d) => d.id);
const notes = () => mem.list("contacts/c1/activities").filter((a) => a.type === "quiet_hours_held");

beforeEach(() => {
  resetSeam();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DAY);
  invalidateAgencyPolicyCache(AGENCY);
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-not-a-real-key";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  sendSmsVia.mockReset().mockResolvedValue({ sid: "SM1" });
  publishCallback.mockReset().mockResolvedValue({ messageId: "m1" });
  mem.seed(`subAccounts/${SA}`, {
    ...SMTP_SUB,
    defaultPhoneCountry: "ZA",
    sendWindow: WINDOW,
    twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27110000000" },
  });
  seedEvent(new Date("2026-09-24T14:00:00Z"));
  seedPage();
  seedContact();
});
afterEach(() => vi.useRealTimers());

describe("the page's text toggle", () => {
  it("is off by default: no text goes", async () => {
    seedPage({ smsRemindersEnabled: undefined, remindersEnabled: true });
    const res = await remind();
    await flushAfterResponse();
    expect(await res.json()).not.toHaveProperty("sms");
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(smtpSend).toHaveBeenCalledOnce();
  });

  it("on: texts the contact once, with the manage link and no place", async () => {
    const res = await remind();
    await flushAfterResponse();
    expect(await res.json()).toMatchObject({ ok: true, sms: "sent", email: "disabled" });
    expect(sendSmsVia).toHaveBeenCalledOnce();
    const [, args] = sendSmsVia.mock.calls[0] as [string, { to: string; body: string }];
    expect(args.to).toBe("+27821234567");
    expect(args.body).toContain("Reminder: Intro call with Fixture Co");
    expect(args.body).not.toContain("12 Long St");
    expect(args.body).toContain("https://app.test/e/");
    expect(smtpSend).not.toHaveBeenCalled();
  });

  it("is read live: switched off after scheduling, the scheduled snapshot does not text", async () => {
    seedPage({ smsRemindersEnabled: false, remindersEnabled: true });
    await remind({ channels: { email: true, sms: true } });
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(smtpSend).toHaveBeenCalledOnce();
  });

  it("falls back to the scheduled snapshot when the page was deleted", async () => {
    mem.clear();
    mem.seed(`subAccounts/${SA}`, { ...SMTP_SUB, defaultPhoneCountry: "ZA", sendWindow: WINDOW, twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27110000000" } });
    seedEvent(new Date("2026-09-24T14:00:00Z"));
    seedContact();
    await remind({ channels: { email: false, sms: true, pageName: "Old name", timezone: "UTC" } });
    await flushAfterResponse();
    expect(sendSmsVia).toHaveBeenCalledOnce();
    expect((sendSmsVia.mock.calls[0] as [string, { body: string }])[1].body).toContain("Old name");
  });

  it("sends the email too when the page has both on, and an email failure does not cost the text", async () => {
    seedPage({ remindersEnabled: true });
    const res = await remind();
    await flushAfterResponse();
    expect(await res.json()).toMatchObject({ ok: true, sms: "sent" });
    expect(sendSmsVia).toHaveBeenCalledOnce();
    expect(smtpSend).toHaveBeenCalledOnce();
  });
});

describe("what the booker typed", () => {
  const HOSTILE = "https://evil.example/pay-now";
  const hostileEvent = () =>
    mem.seed("events/e1", {
      ...mem.read("events/e1"),
      title: `Intro — ${HOSTILE}`,
      location: `At your address: 7 Oak Ave, call 0861234567 (${HOSTILE})`,
    });
  const expectClean = () => {
    expect(sendSmsVia).toHaveBeenCalledOnce();
    const body = (sendSmsVia.mock.calls[0] as [string, { body: string }])[1].body;
    for (const leaked of ["evil", "Oak", "0861234567", "Where"]) expect(body).not.toContain(leaked);
    expect(body.split("\n")).toEqual([
      expect.stringMatching(/^Reminder: .* with Fixture Co, /),
      expect.stringMatching(/^Reschedule or cancel: https:\/\/app\.test\/e\//),
    ]);
  };

  it("never reaches a reminder: not the place, the phone, nor the title (which names the booker)", async () => {
    hostileEvent();
    seedContact({ name: HOSTILE });
    await remind();
    await flushAfterResponse();
    expectClean();
    expect((sendSmsVia.mock.calls[0] as [string, { body: string }])[1].body).toContain("Reminder: Intro call with Fixture Co");
  });

  it("nor when the page is gone: the title is not a fallback for its name", async () => {
    mem.clear();
    mem.seed(`subAccounts/${SA}`, { ...SMTP_SUB, defaultPhoneCountry: "ZA", sendWindow: WINDOW, twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27110000000" } });
    seedEvent(new Date("2026-09-24T14:00:00Z"));
    hostileEvent();
    seedContact({ name: HOSTILE });
    await remind({ channels: { sms: true, email: false } });
    await flushAfterResponse();
    expectClean();
    expect((sendSmsVia.mock.calls[0] as [string, { body: string }])[1].body).toContain("Reminder: your appointment with Fixture Co");
  });

  it("a number outside the home country gets no reminder text and a timeline note", async () => {
    seedContact({ phone: "+14155552671" });
    const res = await remind();
    await flushAfterResponse();
    expect(await res.json()).toMatchObject({ sms: "number_not_allowed" });
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(mem.list("contacts/c1/activities")).toEqual([expect.objectContaining({ content: expect.stringContaining("home country") })]);
  });
});

describe("consent and tenancy", () => {
  it("does not text a contact who opted out of SMS, but still emails them", async () => {
    seedPage({ remindersEnabled: true });
    seedContact({ smsOptedOut: true });
    const res = await remind();
    await flushAfterResponse();
    expect(await res.json()).toMatchObject({ ok: true, sms: "opted_out" });
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(smtpSend).toHaveBeenCalledOnce();
  });

  it("does not text a contact of another sub-account, and writes nothing to them", async () => {
    seedContact({ subAccountId: "other-tenant" });
    const res = await remind();
    await flushAfterResponse();
    expect(await res.json()).toMatchObject({ skipped: "tenancy_missing" });
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(mem.list("contacts/c1/activities")).toHaveLength(0);
    expect(mem.list("contacts/c1/messages")).toHaveLength(0);
  });
});

describe("redelivery", () => {
  it("texts once however often QStash delivers it", async () => {
    await remind();
    await remind();
    await Promise.all([remind(), remind()]);
    await flushAfterResponse();
    expect(sendSmsVia).toHaveBeenCalledOnce();
  });

  it("does not stop a different offset", async () => {
    await remind({}, 60);
    await remind({}, 1440);
    await flushAfterResponse();
    expect(sendSmsVia).toHaveBeenCalledTimes(2);
  });
});

describe("quiet hours", () => {
  beforeEach(() => vi.setSystemTime(NIGHT));

  it("holds the text, sends nothing now, and publishes the step again for the end of the window (text only)", async () => {
    seedEvent(new Date("2026-09-25T09:00:00Z"));
    const res = await remind({ channels: { email: false, sms: true } });
    await flushAfterResponse();
    expect(await res.json()).toMatchObject({ ok: true, sms: "quiet_hours_deferred" });
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(publishCallback).toHaveBeenCalledOnce();
    const call = publishCallback.mock.calls[0][0] as {
      pathname: string;
      delaySeconds: number;
      deduplicationId: string;
      body: Record<string, unknown>;
    };
    expect(call.pathname).toBe("/api/events/reminder/step");
    expect(call.delaySeconds).toBe((MORNING.getTime() - NIGHT.getTime()) / 1000);
    expect(call.body).toMatchObject({ eventId: "e1", offsetMinutes: 60, token, smsOnly: true });
    expect(call.deduplicationId).toContain(`qh${MORNING.getTime()}`);
    expect(notes()).toEqual([expect.objectContaining({ content: expect.stringContaining("held for quiet hours") })]);
  });

  it("sends when the republished step runs after the window, and only the text (the email already went)", async () => {
    seedPage({ remindersEnabled: true });
    seedEvent(new Date("2026-09-25T09:00:00Z"));
    await remind(); // 23:00: email goes now, the text is held
    expect(smtpSend).toHaveBeenCalledOnce();
    vi.setSystemTime(MORNING);
    const res = await remind({ smsOnly: true });
    await flushAfterResponse();
    expect(await res.json()).toMatchObject({ ok: true, sms: "sent" });
    expect(sendSmsVia).toHaveBeenCalledOnce();
    expect(smtpSend).toHaveBeenCalledOnce();
  });

  it("holds again, not sends, when the window is still closed at the republish", async () => {
    seedEvent(new Date("2026-09-25T09:00:00Z"));
    await remind({ smsOnly: true });
    await remind({ smsOnly: true });
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(publishCallback).toHaveBeenCalledTimes(2);
  });

  it("DROPS the text when the window ends after the appointment starts: nothing sent, nothing published", async () => {
    seedEvent(new Date("2026-09-25T05:00:00Z"));
    const res = await remind();
    await flushAfterResponse();
    expect(await res.json()).toMatchObject({ sms: "quiet_hours_dropped" });
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(publishCallback).not.toHaveBeenCalled();
    expect(notes()).toEqual([expect.objectContaining({ content: expect.stringContaining("after the appointment starts") })]);
  });

  it("drops a text whose window ends exactly at the start", async () => {
    seedEvent(MORNING);
    const res = await remind();
    expect(await res.json()).toMatchObject({ sms: "quiet_hours_dropped" });
    expect(publishCallback).not.toHaveBeenCalled();
  });

  it("says so, and sends nothing, when the republish could not be queued", async () => {
    seedEvent(new Date("2026-09-25T09:00:00Z"));
    publishCallback.mockResolvedValueOnce(null);
    const res = await remind();
    expect(await res.json()).toMatchObject({ sms: "quiet_hours_hold_failed" });
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(notes()).toEqual([expect.objectContaining({ content: expect.stringContaining("NOT sent") })]);
  });

  it("releases its claim when held, so the republished step is not 'already_sent'", async () => {
    seedEvent(new Date("2026-09-25T09:00:00Z"));
    await remind();
    expect(claims()).toEqual([]);
  });

  it("a held text is not sent after a cancel or a reschedule: the republished step re-checks", async () => {
    seedEvent(new Date("2026-09-25T09:00:00Z"));
    await remind();
    vi.setSystemTime(MORNING);
    mem.seed("events/e1", { ...mem.read("events/e1"), status: "cancelled" });
    expect(await (await remind({ smsOnly: true })).json()).toMatchObject({ skipped: "status:cancelled" });
    mem.seed("events/e1", { ...mem.read("events/e1"), status: "scheduled", publicTokenHash: issueEventToken("e1").hash });
    expect(await (await remind({ smsOnly: true })).json()).toMatchObject({ skipped: "rotated" });
    expect(sendSmsVia).not.toHaveBeenCalled();
  });
});
