import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * A text normally cannot reach the carrier inside quiet hours: sendBookingSms
 * checks them first, before it claims anything. The one way in is a window
 * boundary crossed between that check and the send, so the check is skipped
 * ONCE here (the seam's own check, inside sendSmsForSubAccount, still runs)
 * to drive the release path: the claim and both cap slots are given back, and
 * when the release itself fails the claim must not stay taken.
 */

const sendSmsVia = vi.fn();
const pre = vi.hoisted(() => ({ skipNext: false }));

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
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

const { SA, AGENCY, mem, resetSeam } = await s();
const { sendBookingSms } = await import("./sms");
const { invalidateAgencyPolicyCache } = await import("@/lib/agency/policy");

const WINDOW = { startHour: 8, endHour: 20, timezone: "Africa/Johannesburg" };
const NIGHT = new Date("2026-09-24T21:00:00Z");
const NEXT_DAY = new Date("2026-09-25T10:00:00Z");
const CLAIM = "events/e1/reminderSends/sms_60_abc";
const sub = () =>
  ({
    agencyId: AGENCY,
    name: "Fixture Co",
    defaultPhoneCountry: "ZA",
    sendWindow: WINDOW,
    twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27110000000" },
  }) as unknown as SubAccountDoc;
const send = () =>
  sendBookingSms({ subAccountId: SA, sub: sub(), contactId: "c1", label: "booking reminder", body: "Reminder", claimPath: CLAIM });
const counts = () => mem.list(`subAccounts/${SA}/bookingSmsCaps`).map((d) => d.count);

/** Makes the next `n` transactions after the first fail, as contention that never clears would. */
function failTransactionsAfterFirst(n: number) {
  const real = mem.db.runTransaction.bind(mem.db);
  let calls = 0;
  return vi.spyOn(mem.db, "runTransaction").mockImplementation(((fn: never) => {
    calls++;
    return calls > 1 && calls <= 1 + n ? Promise.reject(Object.assign(new Error("10 ABORTED: contention"), { code: 10 })) : real(fn);
  }) as never);
}
/** Makes writes to the claim doc fail. */
function failClaimWrites() {
  const real = mem.db.doc.bind(mem.db);
  return vi.spyOn(mem.db, "doc").mockImplementation(((path: string) => {
    const ref = real(path);
    return path === CLAIM ? { ...ref, set: () => Promise.reject(new Error("write failed")) } : ref;
  }) as never);
}

beforeEach(() => {
  resetSeam();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NIGHT);
  invalidateAgencyPolicyCache(AGENCY);
  pre.skipNext = false;
  sendSmsVia.mockReset().mockResolvedValue({ sid: "SM1" });
  mem.seed("contacts/c1", { name: "Thandi", phone: "+27821234567", agencyId: AGENCY, subAccountId: SA });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a hold the seam catches after the reservation", () => {
  it("gives back the claim and both slots", async () => {
    pre.skipNext = true;
    expect(await send()).toMatchObject({ sent: false, reason: "quiet_hours" });
    expect(sendSmsVia).not.toHaveBeenCalled();
    expect(mem.read(CLAIM)).toBeFalsy();
    expect(counts()).toEqual([0, 0]);
  });

  it("then sends once the window is open, counted once", async () => {
    pre.skipNext = true;
    await send();
    vi.setSystemTime(NEXT_DAY);
    expect(await send()).toEqual({ sent: true });
    expect(counts().sort()).toEqual([0, 0, 1, 1]); // yesterday's given back, today's taken
  });
});

describe("when the release fails", () => {
  it("falls back to marking the claim held, and the retry takes it over without counting it twice", async () => {
    const tx = failTransactionsAfterFirst(3);
    pre.skipNext = true;
    expect(await send()).toMatchObject({ sent: false, reason: "quiet_hours" });
    tx.mockRestore();
    expect(mem.read(CLAIM)).toMatchObject({ state: "held" });
    expect(counts()).toEqual([1, 1]);
    // The retry, in an open window: not 'already_sent', and no second slot taken.
    vi.setSystemTime(new Date("2026-09-24T10:00:00Z"));
    expect(await send()).toEqual({ sent: true });
    expect(counts()).toEqual([1, 1]);
    expect(mem.read(CLAIM)).toMatchObject({ state: "sending" });
    expect(sendSmsVia).toHaveBeenCalledOnce();
    // And it is taken now: another delivery sends nothing.
    expect(await send()).toEqual({ sent: false, reason: "already_sent" });
    expect(sendSmsVia).toHaveBeenCalledOnce();
  });

  it("reports release_failed when even the fallback fails, so the caller can retry", async () => {
    failTransactionsAfterFirst(3);
    failClaimWrites();
    pre.skipNext = true;
    expect(await send()).toEqual({ sent: false, reason: "release_failed" });
    expect(sendSmsVia).not.toHaveBeenCalled();
  });
});
