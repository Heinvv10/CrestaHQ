import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The review-request dispatcher's side of quiet hours. The seam (SMS sender,
 * WhatsApp dispatchers) decides; this file checks the dispatcher tells it who
 * is sending, and that a held automatic request is parked for re-run rather
 * than dropped or logged as a failure. Shares the doubles in
 * src/test/reviews-request-harness.ts; the seam itself is quiet-hours-seams.test.ts.
 */

const holdForQuietHours = vi.fn(async () => true);

vi.mock("@/lib/firebase/admin", async () => {
  const h = await import("@/test/reviews-request-harness");
  return { getAdminDb: () => h.fakeDb() };
});
vi.mock("@/lib/comms/twilio", async () => {
  const h = await import("@/test/reviews-request-harness");
  return {
    sendSmsForSubAccount: (...a: unknown[]) => h.sendSms(...(a as [])),
    sendWhatsappForSubAccount: (...a: unknown[]) => h.sendWhatsapp(...(a as [])),
    sendWhatsappTemplateForSubAccount: (...a: unknown[]) => h.sendWhatsappTemplate(...(a as [])),
    smsIsConfigured: () => h.smsIsConfigured(),
    subAccountTwilioIsConfigured: () => h.subAccountTwilioIsConfigured(),
    subAccountWhatsappIsConfigured: () => h.subAccountWhatsappIsConfigured(),
  };
});
vi.mock("@/lib/server/conversations-service", async () => {
  const h = await import("@/test/reviews-request-harness");
  return { upsertConversationForMessage: (...a: unknown[]) => h.upsertConversation(...(a as [])) };
});
vi.mock("@/lib/comms/quiet-hours-hold", () => ({
  holdForQuietHours: (...a: unknown[]) => holdForQuietHours(...(a as [])),
}));

import { AG, C, SA, resetHarness, sendSms, writes } from "@/test/reviews-request-harness";
import { QuietHoursDeferredError } from "@/lib/comms/quiet-hours";
import { maybeSendReviewRequest } from "./request";

const HOLD = { retryAfterSec: 3600, until: new Date("2026-09-25T06:00:00Z") };
const input = (trigger: "manual" | "deal_completed") => ({ subAccountId: SA, agencyId: AG, contactId: C, trigger });

beforeEach(() => {
  resetHarness();
  holdForQuietHours.mockClear();
});

describe("review requests in quiet hours", () => {
  it("marks the manual button's send as manual, and an automatic trigger's as automated", async () => {
    await maybeSendReviewRequest(input("manual"));
    await maybeSendReviewRequest(input("deal_completed"));
    const origins = sendSms.mock.calls.map((c) => (c as unknown as [{ origin?: string }])[0].origin);
    expect(origins).toEqual(["manual", "automated"]);
  });

  it("parks a held automatic request for re-run, writing nothing and logging no failure", async () => {
    sendSms.mockRejectedValueOnce(new QuietHoursDeferredError(HOLD));
    const res = await maybeSendReviewRequest(input("deal_completed"));
    expect(res).toEqual({ sent: false, reason: "quiet_hours_held" });
    expect(holdForQuietHours).toHaveBeenCalledWith({
      agencyId: AG,
      subAccountId: SA,
      payload: { kind: "review_request", request: input("deal_completed") },
      hold: HOLD,
    });
    // No cooldown stamp, no message row, no request log: nothing went out.
    expect(writes).toEqual([]);
  });

  it("hands a held reminder back to its worker instead of parking it", async () => {
    sendSms.mockRejectedValueOnce(new QuietHoursDeferredError(HOLD));
    const res = await maybeSendReviewRequest({
      ...input("deal_completed"),
      trigger: "reminder",
      reminderOf: { requestId: "r1", tracked: false, channel: "sms" },
    });
    expect(res).toEqual({ sent: false, reason: "quiet_hours", quietHours: HOLD });
    expect(holdForQuietHours).not.toHaveBeenCalled();
  });
});
