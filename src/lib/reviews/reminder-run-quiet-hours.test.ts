import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A review reminder that falls in quiet hours is not stopped and not lost: the
 * worker hands the attempt back and fires the SAME attempt again when the
 * window ends, where every stop check runs again. Real worker and dispatcher,
 * in-memory Firestore; the SMS sender and the QStash publish are doubles.
 */

const mem = createMemoryFirestore();
const sendSms = vi.fn();
const publish = vi.fn();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/twilio", () => ({
  smsIsConfigured: () => true,
  subAccountTwilioIsConfigured: () => true,
  sendSmsForSubAccount: (...a: unknown[]) => sendSms(...a),
  sendWhatsappForSubAccount: vi.fn(),
  sendWhatsappTemplateForSubAccount: vi.fn(),
}));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({ publishCallback: (...a: unknown[]) => publish(...a) }));

const { runReviewReminder } = await import("./reminder-run");
const { QuietHoursDeferredError } = await import("@/lib/comms/quiet-hours");

const REQ = "subAccounts/sa1/reviewRequests/req1";
const UNTIL = new Date(Date.now() + 5 * 3600_000);
const run = () => runReviewReminder({ subAccountId: "sa1", requestId: "req1", attempt: 1 });

beforeEach(() => {
  mem.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-for-click-tokens";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  sendSms.mockReset().mockResolvedValue({ sid: "SM1", from: "+15550001", mode: "dedicated" });
  publish.mockReset().mockResolvedValue({ messageId: "q2" });
  mem.seed("subAccounts/sa1", {
    name: "Acme Plumbing", agencyId: "ag1", twilioConfig: { enabled: true, inboundWebhookConfigured: true },
    googleReviewConfig: {
      enabled: false, reviewUrl: "https://g.page/r/acme/review", channel: "sms", messageTemplate: "", whatsappTemplateId: null,
      cooldownDays: 90, triggerOnQuotePaid: false, triggerOnDealCompleted: false, reminder: { everyDays: 2, maxRetries: 2 },
    },
  });
  mem.seed("contacts/c1", { name: "Jane Doe", phone: "+61412345678", agencyId: "ag1", subAccountId: "sa1", reviewRequestedAt: Timestamp.fromMillis(Date.now() - 3600_000) });
  mem.seed(REQ, {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", contactId: "c1", channel: "sms", source: "dispatcher",
    trigger: "manual", status: "sent", failureKind: null, messageSid: "SM0", sentAt: new Date(), clickedAt: null,
    feedbackAt: null, tracked: false,
    reminder: { everyDays: 2, maxRetries: 2, attempts: 0, nextAt: new Date(), state: "scheduled", stopReason: null, lastAttemptAt: null },
  });
});

describe("a reminder in quiet hours", () => {
  it("is sent as automated, then rescheduled — same attempt, at the window's end", async () => {
    sendSms.mockRejectedValueOnce(new QuietHoursDeferredError({ retryAfterSec: 5 * 3600, until: UNTIL }));
    expect(await run()).toEqual({ outcome: "skipped", reason: "quiet_hours" });
    expect((sendSms.mock.calls[0] as [{ origin?: string }])[0].origin).toBe("automated");
    const r = (mem.read(REQ) as { reminder: Record<string, unknown> }).reminder;
    expect(r).toMatchObject({ attempts: 0, state: "scheduled", nextAt: UNTIL, stopReason: null });
    expect(publish).toHaveBeenCalledWith({
      pathname: "/api/cron/review-reminder",
      body: { subAccountId: "sa1", requestId: "req1", attempt: 1 },
      delaySeconds: 5 * 3600,
      deduplicationId: `rr_req1_1_qh_${UNTIL.getTime()}`,
    });
  });

  it("goes out when the rescheduled attempt fires after the window opens", async () => {
    sendSms.mockRejectedValueOnce(new QuietHoursDeferredError({ retryAfterSec: 5 * 3600, until: UNTIL }));
    await run();
    expect(await run()).toEqual({ outcome: "sent" });
    expect(sendSms).toHaveBeenCalledTimes(2);
  });
});
