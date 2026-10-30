import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * The reminder text under cap-counter contention, through the real step
 * route. A text whose cap slot could not be taken is NOT lost and NOT
 * claimed: the step answers 503 so QStash delivers it again. Only the carrier,
 * QStash, usage metering, the credential read and the SMTP wire are stubbed.
 */

const sendSmsVia = vi.fn();
const publishCallback = vi.fn();
const pre = vi.hoisted(() => ({ skipNext: false }));

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
vi.mock("@/lib/comms/quiet-hours", async (orig) => {
  const real = await orig<typeof import("@/lib/comms/quiet-hours")>();
  return {
    ...real,
    quietHoursHold: (...a: Parameters<typeof real.quietHoursHold>) => {
      if (pre.skipNext) {
        pre.skipNext = false;
        return null;
      }
      return real.quietHoursHold(...a);
    },
  };
});

const { SA, AGENCY, SMTP_SUB, mem, resetSeam, smtpSend } = await s();
const { POST } = await import("./route");
const { issueEventToken } = await import("@/lib/booking/event-token");
const { invalidateAgencyPolicyCache } = await import("@/lib/agency/policy");
const { BOOKING_SMS_PER_SUBACCOUNT_PER_DAY } = await import("@/lib/booking/sms-caps");

const WINDOW = { startHour: 8, endHour: 20, timezone: "Africa/Johannesburg" };
const DAY = new Date("2026-09-24T10:00:00Z");
const NIGHT = new Date("2026-09-24T21:00:00Z");
const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });

const tokens = new Map<string, string>();
const remind = (eventId: string, extra: Record<string, unknown> = {}) =>
  POST(
    new Request("https://app.test/api/events/reminder/step", {
      method: "POST",
      headers: { "Upstash-Signature": "sig" },
      body: JSON.stringify({ eventId, offsetMinutes: 60, token: tokens.get(eventId), ...extra }),
    }),
  );
/** Seeds booking `n`: its own event, contact and (distinct) number. */
function seedBooking(n: number, start = new Date("2026-09-24T14:00:00Z")) {
  const id = `e${n}`;
  const issued = issueEventToken(id);
  tokens.set(id, issued.token);
  mem.seed(`events/${id}`, {
    agencyId: AGENCY, subAccountId: SA, status: "scheduled", title: "Intro", contactId: `c${n}`,
    bookingPageSlug: "p1", publicTokenHash: issued.hash, startAt: ts(start), endAt: ts(new Date(start.getTime() + 1800_000)),
  });
  mem.seed(`contacts/c${n}`, {
    name: "Thandi", email: `t${n}@example.co.za`, phone: `+2782123${String(1000 + n)}`, agencyId: AGENCY, subAccountId: SA,
  });
  return id;
}
const claims = () => mem.list("events/e0/reminderSends").filter((d) => d.id.startsWith("sms_"));

beforeEach(() => {
  resetSeam();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DAY);
  invalidateAgencyPolicyCache(AGENCY);
  pre.skipNext = false;
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
  mem.seed(`subAccounts/${SA}/bookingPages/p1`, { name: "Intro call", timezone: "UTC", durationMinutes: 30, remindersEnabled: false, smsRemindersEnabled: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Every transaction fails (`n` of them, then they work again), as contention that outlasts the retries would. */
function failTransactions(n: number) {
  const real = mem.db.runTransaction.bind(mem.db);
  let left = n;
  return vi.spyOn(mem.db, "runTransaction").mockImplementation(((fn: never) =>
    left-- > 0 ? Promise.reject(Object.assign(new Error("10 ABORTED: contention"), { code: 10 })) : real(fn)) as never);
}

describe("a burst of reminders for one sub-account", () => {
  it("25 at once: all 25 are texted exactly once, none lost (any 503 is redelivered, as QStash does)", async () => {
    const ids = Array.from({ length: 25 }, (_, n) => seedBooking(n));
    const statuses: number[] = [];
    let pending = ids;
    for (let round = 0; round < 15 && pending.length > 0; round++) {
      const res = await Promise.all(pending.map((id) => remind(id)));
      statuses.push(...res.map((r) => r.status));
      pending = pending.filter((_, i) => res[i].status === 503);
    }
    await flushAfterResponse();
    expect(pending).toEqual([]);
    expect(statuses.every((st) => st === 200 || st === 503)).toBe(true);
    expect(sendSmsVia).toHaveBeenCalledTimes(25);
    expect(new Set(sendSmsVia.mock.calls.map((c) => (c[1] as { to: string }).to)).size).toBe(25);
    expect(mem.read(`subAccounts/${SA}/bookingSmsCaps/2026-09-24`)).toMatchObject({ count: 25 });
    expect(25).toBeLessThan(BOOKING_SMS_PER_SUBACCOUNT_PER_DAY);
  }, 60_000);
});

describe("a cap slot that cannot be taken", () => {
  it("answers 503 with no claim and no text, and the redelivery sends", async () => {
    seedBooking(0);
    const tx = failTransactions(1000);
    const res = await remind("e0");
    await flushAfterResponse();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ sms: "cap_unavailable" });
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(claims()).toEqual([]);
    // Not noted as a final failure: it is being retried.
    expect(mem.list("contacts/c0/activities")).toEqual([]);
    tx.mockRestore();
    expect((await remind("e0")).status).toBe(200);
    expect(sendSmsVia).toHaveBeenCalledOnce();
  });

  it("holds the email back too until the retry, so nothing is sent twice", async () => {
    seedBooking(0);
    mem.seed(`subAccounts/${SA}/bookingPages/p1`, { name: "Intro call", timezone: "UTC", durationMinutes: 30, remindersEnabled: true, smsRemindersEnabled: true });
    const tx = failTransactions(1000);
    expect((await remind("e0")).status).toBe(503);
    expect(smtpSend).not.toHaveBeenCalled();
    tx.mockRestore();
    expect((await remind("e0")).status).toBe(200);
    expect(smtpSend).toHaveBeenCalledOnce();
    expect(sendSmsVia).toHaveBeenCalledOnce();
  });

  it("retries in place first: contention that clears within a few tries is not even a 503", async () => {
    seedBooking(0);
    failTransactions(2);
    const res = await remind("e0");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sms: "sent" });
    expect(sendSmsVia).toHaveBeenCalledOnce();
  });
});

describe("a release that fails", () => {
  it("answers 503 so QStash tries again, and the claim is not left taken for the retry", async () => {
    seedBooking(0, new Date("2026-09-25T09:00:00Z"));
    vi.setSystemTime(NIGHT);
    // The window boundary crossed between the check and the send; the release then fails everywhere.
    const real = mem.db.runTransaction.bind(mem.db);
    let calls = 0;
    vi.spyOn(mem.db, "runTransaction").mockImplementation(((fn: never) =>
      ++calls === 1 ? real(fn) : Promise.reject(Object.assign(new Error("10 ABORTED"), { code: 10 }))) as never);
    const realDoc = mem.db.doc.bind(mem.db);
    vi.spyOn(mem.db, "doc").mockImplementation(((path: string) => {
      const ref = realDoc(path);
      return path.includes("/reminderSends/sms_") ? { ...ref, set: () => Promise.reject(new Error("write failed")) } : ref;
    }) as never);
    pre.skipNext = true;
    const res = await remind("e0");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ sms: "release_failed" });
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(publishCallback).not.toHaveBeenCalled();
  });

  it("when the release works but the claim write is the only thing failing, the hold simply goes ahead", async () => {
    seedBooking(0, new Date("2026-09-25T09:00:00Z"));
    vi.setSystemTime(NIGHT);
    pre.skipNext = true;
    const res = await remind("e0");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sms: "quiet_hours_deferred" });
    expect(claims()).toEqual([]);
    expect(publishCallback).toHaveBeenCalledOnce();
  });
});
