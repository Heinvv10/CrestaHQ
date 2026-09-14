import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * SP5 d2 — the reminder worker over the REAL dispatcher and an in-memory
 * Firestore (only Twilio, the inbox upsert and the QStash publish are
 * doubles). Every stop condition, and idempotence under QStash redelivery:
 * one reminder attempt is at most one message.
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
const { buildReviewClickUrl } = await import("./click-token");

const REVIEW_URL = "https://g.page/r/acme/review";
const REQ = "subAccounts/sa1/reviewRequests/req1";
const req = () => mem.read(REQ) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = (attempt = 1) => runReviewReminder({ subAccountId: "sa1", requestId: "req1", attempt });

function setConfig(over: Record<string, unknown> = {}, sub: Record<string, unknown> = {}) {
  mem.seed("subAccounts/sa1", {
    name: "Acme Plumbing", agencyId: "ag1", twilioConfig: { enabled: true, inboundWebhookConfigured: true }, whatsappEnabledByAgency: true, ...sub,
    googleReviewConfig: {
      enabled: false, reviewUrl: REVIEW_URL, channel: "sms", messageTemplate: "", whatsappTemplateId: null,
      cooldownDays: 90, triggerOnQuotePaid: false, triggerOnDealCompleted: false,
      reminder: { everyDays: 2, maxRetries: 2 }, ...over,
    },
  });
}

function seedRequest(reminder: Record<string, unknown> = {}, more: Record<string, unknown> = {}) {
  mem.seed(REQ, {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", contactId: "c1", channel: "sms", source: "dispatcher",
    trigger: "manual", status: "sent", failureKind: null, messageSid: "SM0", sentAt: new Date(), clickedAt: null,
    feedbackAt: null, tracked: true, ...more,
    reminder: {
      everyDays: 2, maxRetries: 2, attempts: 0, nextAt: new Date(), state: "scheduled", stopReason: null, lastAttemptAt: null,
      ...reminder,
    },
  });
}

beforeEach(() => {
  mem.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-for-click-tokens";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  sendSms.mockReset().mockResolvedValue({ sid: "SM1", from: "+15550001", mode: "dedicated" });
  publish.mockReset().mockResolvedValue({ messageId: "q2" });
  setConfig();
  // Asked an hour ago: a normal auto send would be inside the cooldown.
  mem.seed("contacts/c1", { name: "Jane Doe", phone: "+61412345678", agencyId: "ag1", subAccountId: "sa1", reviewRequestedAt: Timestamp.fromMillis(Date.now() - 3600_000) });
  seedRequest();
});

describe("a due reminder", () => {
  it("re-sends the SAME tracked link past the cooldown, records the attempt on the request, schedules the next", async () => {
    expect(await run(1)).toEqual({ outcome: "sent" });
    expect(sendSms).toHaveBeenCalledTimes(1);
    const body = (sendSms.mock.calls[0] as [{ body: string }])[0].body;
    expect(body).toBe(`Hi Jane, thanks for choosing Acme Plumbing! If you have a moment, a quick Google review would mean a lot: ${buildReviewClickUrl("sa1", "req1")}`);
    expect(req().reminder).toMatchObject({ attempts: 1, state: "scheduled", stopReason: null });
    expect(req().reminder.lastAttemptAt).toBeInstanceOf(Date);
    expect(req().reminder.nextAt).toBeInstanceOf(Date);
    // Not a new request row.
    expect(mem.list("subAccounts/sa1/reviewRequests")).toHaveLength(1);
    expect(publish).toHaveBeenCalledWith({
      pathname: "/api/cron/review-reminder", body: { subAccountId: "sa1", requestId: "req1", attempt: 2 },
      delaySeconds: 2 * 86400, deduplicationId: "rr_req1_2",
    });
    expect(mem.list("contacts/c1/activities").at(-1)?.meta).toMatchObject({ trigger: "reminder" });
  });

  it("an untracked request's reminder carries the plain review link", async () => {
    seedRequest({}, { tracked: false });
    await run(1);
    expect((sendSms.mock.calls[0] as [{ body: string }])[0].body).toContain(REVIEW_URL);
  });

  it("the last one is marked done (retries exhausted) and schedules nothing", async () => {
    seedRequest({ attempts: 1 });
    expect(await run(2)).toEqual({ outcome: "sent" });
    expect(req().reminder).toMatchObject({ attempts: 2, state: "done", stopReason: "retries_exhausted", nextAt: null });
    expect(publish).not.toHaveBeenCalled();
  });

  it("a failure to schedule the next stops the chain (schedule_failed); the reminder itself went", async () => {
    publish.mockResolvedValueOnce(null);
    expect(await run(1)).toEqual({ outcome: "sent" });
    expect(req().reminder).toMatchObject({ attempts: 1, state: "stopped", stopReason: "schedule_failed" });
  });
});

describe("stops without sending", () => {
  it.each([
    ["the customer clicked", () => seedRequest({}, { clickedAt: new Date() }), "clicked"],
    ["reminders were switched off", () => setConfig({ reminder: { everyDays: null, maxRetries: 2 } }), "reminders_off"],
    ["the reminder setting was removed", () => setConfig({ reminder: undefined }), "reminders_off"],
    ["the review link was removed", () => setConfig({ reviewUrl: "" }), "not_configured"],
    ["the review config was cleared", () => mem.seed("subAccounts/sa1", { name: "Acme Plumbing", agencyId: "ag1", googleReviewConfig: null }), "reminders_off"],
    ["retries already ran out", () => seedRequest({ attempts: 2, maxRetries: 2 }), "retries_exhausted"],
    ["the review channel changed", () => setConfig({ channel: "whatsapp_manual" }), "channel_changed"],
  ])("%s", async (_l, arrange, reason) => {
    arrange();
    const attempt = (req().reminder.attempts as number) + 1;
    expect(await run(attempt)).toEqual({ outcome: "stopped", reason });
    expect(sendSms).not.toHaveBeenCalled();
    // Stopped before the claim: the attempt count is untouched.
    expect(req().reminder).toMatchObject({
      state: reason === "retries_exhausted" ? "done" : "stopped", stopReason: reason, nextAt: null, attempts: attempt - 1,
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    ["the contact opted out", () => mem.seed("contacts/c1", { ...mem.read("contacts/c1"), smsOptedOut: true }), "opted_out"],
    ["the contact has no phone any more", () => mem.seed("contacts/c1", { ...mem.read("contacts/c1"), phone: "" }), "no_phone"],
    ["the sub-account can no longer send SMS", () => sendSms.mockRejectedValueOnce(new Error("carrier down")), "send_failed"],
  ])("%s (the dispatcher refuses; the reminder stops with its reason)", async (_l, arrange, reason) => {
    await arrange();
    expect(await run(1)).toEqual({ outcome: "stopped", reason });
    expect(req().reminder).toMatchObject({ attempts: 1, state: "stopped", stopReason: reason });
    expect(publish).not.toHaveBeenCalled();
  });

  it("WhatsApp gated off by the agency", async () => {
    setConfig({ channel: "whatsapp_manual" }, { whatsappEnabledByAgency: false });
    seedRequest({}, { channel: "whatsapp" });
    expect(await run(1)).toEqual({ outcome: "stopped", reason: "whatsapp_gate_off" });
  });
});

describe("idempotent under QStash redelivery", () => {
  it("the same attempt delivered twice sends once", async () => {
    await run(1);
    expect(await run(1)).toEqual({ outcome: "skipped", reason: "stale_attempt" });
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("two deliveries at once send once", async () => {
    const results = await Promise.all([run(1), run(1)]);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.outcome).sort()).toEqual(["sent", "skipped"]);
  });

  it("an attempt out of order, a stopped reminder, or a missing request does nothing", async () => {
    expect(await run(3)).toEqual({ outcome: "skipped", reason: "stale_attempt" });
    seedRequest({ state: "stopped", stopReason: "clicked" });
    expect(await run(1)).toEqual({ outcome: "skipped", reason: "state:stopped" });
    mem.db.doc(REQ).delete();
    expect(await run(1)).toEqual({ outcome: "skipped", reason: "missing" });
    expect(sendSms).not.toHaveBeenCalled();
  });
});
