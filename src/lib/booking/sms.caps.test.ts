import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * The destination and volume limits on booking texts, through the REAL sender
 * and the real transactions over an in-memory Firestore (which retries
 * conflicting transactions as Firestore does). Only the carrier call, usage
 * metering, the credential read and the inbox index are stubbed.
 * 21:00Z = 23:00 SAST, outside the 08:00-20:00 window.
 */

const sendSmsVia = vi.fn();

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/comms/sms/select", () => ({ sendSmsVia: (...a: unknown[]) => sendSmsVia(...a) }));
vi.mock("@/lib/server/sub-account-secrets", () => ({ readSubAccountSecret: async () => "token" }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));

const { SA, AGENCY, mem, resetSeam } = await s();
const { sendBookingSms } = await import("./sms");
const { BOOKING_SMS_PER_NUMBER_PER_DAY, BOOKING_SMS_PER_SUBACCOUNT_PER_DAY } = await import("./sms-caps");
const { invalidateAgencyPolicyCache } = await import("@/lib/agency/policy");

const WINDOW = { startHour: 8, endHour: 20, timezone: "Africa/Johannesburg" };
const DAY = new Date("2026-09-24T10:00:00Z");
const NIGHT = new Date("2026-09-24T21:00:00Z");
const NEXT_DAY = new Date("2026-09-25T10:00:00Z");
const TODAY = "2026-09-24";

const DEDICATED = { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27110000000" };
const sub = (over: Record<string, unknown> = {}) =>
  ({ agencyId: AGENCY, name: "Fixture Co", defaultPhoneCountry: "ZA", sendWindow: WINDOW, twilioConfig: DEDICATED, ...over }) as unknown as SubAccountDoc;

let n = 0;
const send = (over: Partial<Parameters<typeof sendBookingSms>[0]> = {}) =>
  sendBookingSms({
    subAccountId: SA,
    sub: sub(),
    contactId: "c1",
    label: "booking reminder",
    body: "Reminder",
    claimPath: `events/e1/reminderSends/sms_${++n}`,
    ...over,
  });
const seedContact = (id: string, phone: string | undefined, over: Record<string, unknown> = {}) =>
  mem.seed(`contacts/${id}`, { name: "Thandi", phone, agencyId: AGENCY, subAccountId: SA, ...over });
const results = (rs: Array<{ sent: boolean; reason?: string }>) => rs.map((r) => (r.sent ? "sent" : r.reason));
const sent = (rs: Array<{ sent: boolean }>) => rs.filter((r) => r.sent).length;
const counter = (path: string) => (mem.read(path) as { count?: number } | undefined)?.count;
const numberDocs = () => mem.list(`subAccounts/${SA}/bookingSmsCaps`).filter((d) => d.id.includes("_"));

beforeEach(() => {
  resetSeam();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DAY);
  invalidateAgencyPolicyCache(AGENCY);
  sendSmsVia.mockReset().mockResolvedValue({ sid: "SM1" });
  seedContact("c1", "+27821234567");
});
afterEach(() => vi.useRealTimers());

describe("home country", () => {
  it("sends a national number as its E.164 form", async () => {
    seedContact("c1", "082 123 4567");
    expect(await send()).toEqual({ sent: true });
    expect((sendSmsVia.mock.calls[0][1] as { to: string }).to).toBe("+27821234567");
  });

  it.each([
    ["a US number", "+14155552671"],
    ["a UK number", "+447911123456"],
    ["a 00-prefixed foreign number", "0044 7911 123456"],
    ["a premium-rate number in the home country", "090 012 3456"],
    ["a toll-free number in the home country", "0800 123 456"],
    ["junk", "78893"],
    ["a vanity number", "082 FLOWERS"],
  ])("refuses %s: no text, a timeline note, no cap slot used", async (_label, phone) => {
    seedContact("c1", phone);
    expect(await send()).toEqual({ sent: false, reason: "number_not_allowed" });
    await flushAfterResponse();
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(mem.list("contacts/c1/activities")).toEqual([
      expect.objectContaining({ type: "note_added", createdBy: "booking", content: expect.stringContaining("home country") }),
    ]);
    expect(mem.list(`subAccounts/${SA}/bookingSmsCaps`)).toHaveLength(0);
    expect(mem.list("events/e1/reminderSends")).toHaveLength(0);
  });

  it("a workspace with no home country set reads as US: a ZA number is refused, a US one sent", async () => {
    expect(await send({ sub: sub({ defaultPhoneCountry: undefined }) })).toMatchObject({ reason: "number_not_allowed" });
    seedContact("c1", "+14155552671");
    expect(await send({ sub: sub({ defaultPhoneCountry: undefined }) })).toEqual({ sent: true });
  });
});

describe("per-number daily cap", () => {
  it(`sends ${BOOKING_SMS_PER_NUMBER_PER_DAY} to one number a day, then refuses the next with no send`, async () => {
    const rs = [];
    for (let i = 0; i <= BOOKING_SMS_PER_NUMBER_PER_DAY; i++) rs.push(await send());
    expect(results(rs)).toEqual([...Array(BOOKING_SMS_PER_NUMBER_PER_DAY).fill("sent"), "cap_number"]);
    expect(sendSmsVia).toHaveBeenCalledTimes(BOOKING_SMS_PER_NUMBER_PER_DAY);
    // The refused text left no claim behind and used no slot.
    expect(mem.list("events/e1/reminderSends")).toHaveLength(BOOKING_SMS_PER_NUMBER_PER_DAY);
    expect(counter(`subAccounts/${SA}/bookingSmsCaps/${TODAY}`)).toBe(BOOKING_SMS_PER_NUMBER_PER_DAY);
  });

  it("holds under concurrency: 3x the cap in flight at once never sends more than the cap", async () => {
    const rs = await Promise.all(Array.from({ length: BOOKING_SMS_PER_NUMBER_PER_DAY * 3 }, () => send()));
    await flushAfterResponse();
    expect(sent(rs)).toBeLessThanOrEqual(BOOKING_SMS_PER_NUMBER_PER_DAY);
    expect(sent(rs)).toBeGreaterThan(0);
    expect(sendSmsVia).toHaveBeenCalledTimes(sent(rs));
    expect(numberDocs().map((d) => d.count)).toEqual([sent(rs)]);
    for (const r of rs) if (!r.sent) expect(["cap_number", "cap_unavailable"]).toContain(r.reason);
  });

  it("counts a number once however it is written (national, spaced, +)", async () => {
    for (const phone of ["082 123 4567", "+27 82 123 4567", "0821234567"]) {
      seedContact("c1", phone);
      await send();
    }
    expect(numberDocs()).toHaveLength(1);
    expect(numberDocs()[0].count).toBe(3);
  });

  it("is per number: another number is unaffected", async () => {
    for (let i = 0; i < BOOKING_SMS_PER_NUMBER_PER_DAY; i++) await send();
    seedContact("c2", "+27821234599");
    expect(await send({ contactId: "c2" })).toEqual({ sent: true });
  });

  it("starts again the next UTC day", async () => {
    for (let i = 0; i < BOOKING_SMS_PER_NUMBER_PER_DAY; i++) await send();
    expect(await send()).toMatchObject({ reason: "cap_number" });
    vi.setSystemTime(NEXT_DAY);
    expect(await send()).toEqual({ sent: true });
  });

  it("is per sub-account: the same number in another sub-account has its own count", async () => {
    for (let i = 0; i < BOOKING_SMS_PER_NUMBER_PER_DAY; i++) await send();
    mem.seed("contacts/c9", { name: "Thandi", phone: "+27821234567", agencyId: AGENCY, subAccountId: "sa2" });
    mem.seed("subAccounts/sa2", { agencyId: AGENCY });
    expect(await send({ subAccountId: "sa2", contactId: "c9", sub: sub() })).toEqual({ sent: true });
  });
});

describe("per-sub-account daily cap", () => {
  const seedSubCount = (count: number) =>
    mem.seed(`subAccounts/${SA}/bookingSmsCaps/${TODAY}`, { count, subAccountId: SA, agencyId: AGENCY });
  const seedMany = (k: number) => {
    for (let i = 0; i < k; i++) seedContact(`n${i}`, `+278212345${String(10 + i).padStart(2, "0")}`);
  };

  it("refuses once the sub-account is at its cap, whatever the number", async () => {
    seedSubCount(BOOKING_SMS_PER_SUBACCOUNT_PER_DAY);
    expect(await send()).toEqual({ sent: false, reason: "cap_subaccount" });
    expect(sendSmsVia).not.toHaveBeenCalled();
  });

  it("holds under concurrency: with one slot left, 8 different numbers send exactly one", async () => {
    seedSubCount(BOOKING_SMS_PER_SUBACCOUNT_PER_DAY - 1);
    seedMany(8);
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => send({ contactId: `n${i}` })));
    await flushAfterResponse();
    expect(sent(rs)).toBe(1);
    expect(sendSmsVia).toHaveBeenCalledTimes(1);
    expect(counter(`subAccounts/${SA}/bookingSmsCaps/${TODAY}`)).toBe(BOOKING_SMS_PER_SUBACCOUNT_PER_DAY);
    for (const r of rs) if (!r.sent) expect(["cap_subaccount", "cap_unavailable"]).toContain(r.reason);
  });

  it("a refusal by the number cap does not use a sub-account slot", async () => {
    for (let i = 0; i < BOOKING_SMS_PER_NUMBER_PER_DAY; i++) await send();
    await send();
    expect(counter(`subAccounts/${SA}/bookingSmsCaps/${TODAY}`)).toBe(BOOKING_SMS_PER_NUMBER_PER_DAY);
  });

  it("starts again the next UTC day", async () => {
    seedSubCount(BOOKING_SMS_PER_SUBACCOUNT_PER_DAY);
    vi.setSystemTime(NEXT_DAY);
    expect(await send()).toEqual({ sent: true });
  });
});

describe("the claim", () => {
  it("is taken in the same transaction as the slots: one text for a claim, however often it is delivered", async () => {
    const claimPath = "events/e1/reminderSends/sms_60_abc";
    const rs = await Promise.all(Array.from({ length: 6 }, () => send({ claimPath })));
    await flushAfterResponse();
    expect(sent(rs)).toBe(1);
    expect(sendSmsVia).toHaveBeenCalledTimes(1);
    expect(numberDocs()[0].count).toBe(1);
    for (const r of rs) if (!r.sent) expect(["already_sent", "cap_unavailable"]).toContain(r.reason);
  });

  it("is kept after a send that went to the carrier and failed (at most once)", async () => {
    sendSmsVia.mockRejectedValueOnce(new Error("carrier down"));
    const claimPath = "events/e1/reminderSends/sms_60_abc";
    expect(await send({ claimPath })).toEqual({ sent: false, reason: "send_failed" });
    expect(await send({ claimPath })).toEqual({ sent: false, reason: "already_sent" });
    expect(sendSmsVia).toHaveBeenCalledTimes(1);
  });

  it("a text held by quiet hours takes no claim and no cap slot at all: the check comes before the reservation", async () => {
    vi.setSystemTime(NIGHT);
    const claimPath = "events/e1/reminderSends/sms_60_abc";
    for (let i = 0; i < BOOKING_SMS_PER_NUMBER_PER_DAY * 2; i++) {
      expect(await send({ claimPath })).toMatchObject({ sent: false, reason: "quiet_hours" });
    }
    expect(mem.read(claimPath)).toBeFalsy();
    expect(mem.list(`subAccounts/${SA}/bookingSmsCaps`)).toHaveLength(0);
    expect(sendSmsVia).not.toHaveBeenCalled();
    vi.setSystemTime(NEXT_DAY);
    expect(await send({ claimPath })).toEqual({ sent: true });
  });

  it("a refusal before the carrier (opted out, no sender) takes no claim and no slot", async () => {
    seedContact("c1", "+27821234567", { smsOptedOut: true });
    expect(await send()).toMatchObject({ reason: "opted_out" });
    seedContact("c1", "+27821234567");
    expect(await send({ sub: sub({ twilioConfig: undefined }) })).toMatchObject({ reason: "sms_not_configured" });
    expect(mem.list(`subAccounts/${SA}/bookingSmsCaps`)).toHaveLength(0);
    expect(mem.list("events/e1/reminderSends")).toHaveLength(0);
  });
});
