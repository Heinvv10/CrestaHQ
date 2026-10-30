import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Booking texts through the REAL sender: sendBookingSms -> sendSmsForSubAccount
 * (quiet hours, quota, credentials) over an in-memory Firestore. Only the
 * carrier call, usage metering, the credential read and the inbox index are
 * stubbed. 21:00Z = 23:00 SAST, outside the 08:00-20:00 window.
 */

const sendSmsVia = vi.fn();
const upsertConversation = vi.fn();
const readSecret = vi.fn();

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/comms/sms/select", () => ({
  sendSmsVia: (...a: unknown[]) => sendSmsVia(...a),
}));
vi.mock("@/lib/server/sub-account-secrets", () => ({
  readSubAccountSecret: (...a: unknown[]) => readSecret(...a),
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: (...a: unknown[]) => upsertConversation(...a),
}));

const { SA, AGENCY, mem, resetSeam } = await s();
const { sendBookingSms } = await import("./sms");
const { invalidateAgencyPolicyCache } = await import("@/lib/agency/policy");

const WINDOW = { startHour: 8, endHour: 20, timezone: "Africa/Johannesburg" };
const NIGHT = new Date("2026-09-24T21:00:00Z");
const DAY = new Date("2026-09-24T10:00:00Z");
const OPEN = new Date("2026-09-25T06:00:00Z");

const DEDICATED = { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27110000000" };
const sub = (over: Record<string, unknown> = {}) =>
  ({ agencyId: AGENCY, name: "Fixture Co", sendWindow: WINDOW, twilioConfig: DEDICATED, ...over }) as unknown as SubAccountDoc;

const send = (over: Partial<Parameters<typeof sendBookingSms>[0]> = {}) =>
  sendBookingSms({
    subAccountId: SA,
    sub: sub(),
    contactId: "c1",
    label: "booking confirmation",
    body: "You're booked",
    ...over,
  });

const seedContact = (over: Record<string, unknown> = {}) =>
  mem.seed("contacts/c1", { name: "Thandi", phone: "+27821234567", agencyId: AGENCY, subAccountId: SA, ...over });

const SHARED_ENV = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"] as const;

beforeEach(() => {
  resetSeam();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DAY);
  invalidateAgencyPolicyCache(AGENCY);
  sendSmsVia.mockReset().mockResolvedValue({ sid: "SM1" });
  upsertConversation.mockReset().mockResolvedValue(undefined);
  readSecret.mockReset().mockResolvedValue("token");
  for (const k of SHARED_ENV) delete process.env[k];
  seedContact();
});
afterEach(() => vi.useRealTimers());

const rows = (coll: string) => mem.list(`contacts/c1/${coll}`);

describe("consent", () => {
  it("does not text a contact who replied STOP", async () => {
    seedContact({ smsOptedOut: true });
    expect(await send()).toEqual({ sent: false, reason: "opted_out" });
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(rows("activities")).toHaveLength(0);
  });

  it("does not text a contact who declined SMS consent", async () => {
    seedContact({ smsConsent: { consented: false } });
    expect(await send()).toEqual({ sent: false, reason: "opted_out" });
    expect(sendSmsVia).not.toHaveBeenCalled();
  });

  it("does not text a contact with no phone number", async () => {
    seedContact({ phone: undefined });
    expect(await send()).toEqual({ sent: false, reason: "no_phone" });
    expect(sendSmsVia).not.toHaveBeenCalled();
  });

  it("records a carrier STOP (21610) on the contact, so later sends are blocked", async () => {
    sendSmsVia.mockRejectedValueOnce(Object.assign(new Error("unsubscribed"), { code: 21610 }));
    expect(await send()).toEqual({ sent: false, reason: "carrier_unsubscribed" });
    expect(mem.read("contacts/c1")).toMatchObject({ smsOptedOut: true });
    expect(await send()).toEqual({ sent: false, reason: "opted_out" });
    expect(sendSmsVia).toHaveBeenCalledOnce();
  });
});

describe("tenant check", () => {
  it("treats a contact of another sub-account as missing: no text, no timeline row, no thread row", async () => {
    seedContact({ subAccountId: "someone-else" });
    expect(await send()).toEqual({ sent: false, reason: "no_contact" });
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(rows("activities")).toHaveLength(0);
    expect(rows("messages")).toHaveLength(0);
    expect(upsertConversation).not.toHaveBeenCalled();
  });

  it("treats a contact id that is a path as missing", async () => {
    expect(await send({ contactId: "c1/activities/x" })).toEqual({ sent: false, reason: "no_contact" });
    expect(sendSmsVia).not.toHaveBeenCalled();
  });
});

describe("sender: dedicated versus shared", () => {
  it("dedicated: sends from the sub-account's number, with a timeline row, a thread row and an inbox entry", async () => {
    const r = await send();
    await flushAfterResponse();
    expect(r).toEqual({ sent: true });
    expect(sendSmsVia).toHaveBeenCalledOnce();
    expect(readSecret).toHaveBeenCalledWith(SA, "twilio", expect.objectContaining({ accountSid: "AC1" }));
    expect(rows("activities")).toEqual([
      expect.objectContaining({ type: "sms_sent", createdBy: "booking", meta: { sid: "SM1", mode: "dedicated" } }),
    ]);
    expect(rows("messages")).toEqual([
      expect.objectContaining({ id: "SM1", direction: "outbound", from: "+27110000000", to: "+27821234567", subAccountId: SA }),
    ]);
    expect(upsertConversation).toHaveBeenCalledOnce();
  });

  describe("shared sender", () => {
    beforeEach(() => {
      process.env.TWILIO_ACCOUNT_SID = "AC999";
      process.env.TWILIO_AUTH_TOKEN = "shared-token";
      process.env.TWILIO_FROM_NUMBER = "+27119999999";
    });

    it("sends when the agency allows it, with a timeline row but NO thread row (a reply could not be attributed)", async () => {
      mem.seed(`agencies/${AGENCY}`, { sharedSmsAllowed: true });
      const r = await send({ sub: sub({ twilioConfig: undefined }) });
      await flushAfterResponse();
      expect(r).toEqual({ sent: true });
      expect(rows("activities")).toEqual([expect.objectContaining({ meta: { sid: "SM1", mode: "shared" } })]);
      expect(rows("messages")).toHaveLength(0);
      expect(upsertConversation).not.toHaveBeenCalled();
    });

    it("does not send when the agency has turned the shared sender off", async () => {
      mem.seed(`agencies/${AGENCY}`, { sharedSmsAllowed: false });
      expect(await send({ sub: sub({ twilioConfig: undefined }) })).toEqual({ sent: false, reason: "sms_not_configured" });
      expect(sendSmsVia).not.toHaveBeenCalled();
    });
  });

  it("does not send when neither a dedicated nor a shared sender exists", async () => {
    expect(await send({ sub: sub({ twilioConfig: undefined }) })).toEqual({ sent: false, reason: "sms_not_configured" });
    expect(sendSmsVia).not.toHaveBeenCalled();
  });
});

describe("quiet hours", () => {
  it("holds an automated text at 23:00 and says when the window ends; nothing is sent or written", async () => {
    vi.setSystemTime(NIGHT);
    const r = await send();
    await flushAfterResponse();
    expect(r).toMatchObject({ sent: false, reason: "quiet_hours" });
    expect((r as { hold: { until: Date } }).hold.until).toEqual(OPEN);
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(rows("activities")).toHaveLength(0);
  });

  it("sends a customer's own fresh booking confirmation at 23:00", async () => {
    vi.setSystemTime(NIGHT);
    const r = await send({ selfTriggeredBookingAt: new Date(NIGHT.getTime() - 60_000) });
    expect(r).toEqual({ sent: true });
    expect(sendSmsVia).toHaveBeenCalledOnce();
  });

  it("holds a confirmation whose booking is older than the exemption", async () => {
    vi.setSystemTime(NIGHT);
    const r = await send({ selfTriggeredBookingAt: new Date(NIGHT.getTime() - 11 * 60_000) });
    expect(r).toMatchObject({ sent: false, reason: "quiet_hours" });
    expect(sendSmsVia).not.toHaveBeenCalled();
  });

  it("sends inside the window with no exemption", async () => {
    expect(await send()).toEqual({ sent: true });
  });
});

describe("a failing carrier", () => {
  it("never throws: reports send_failed", async () => {
    sendSmsVia.mockRejectedValueOnce(new Error("carrier down"));
    expect(await send()).toEqual({ sent: false, reason: "send_failed" });
    expect(rows("activities")).toHaveLength(0);
  });
});
