import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A held automated send (AI reply, missed-call text-back, review request) is
 * parked, then released by QStash when quiet hours end. The release re-checks
 * opt-out before sending, never sends twice, and is held again if it is still
 * quiet. In-memory Firestore; the SMS sender is a spy, so nothing is sent.
 * 21:00Z = 23:00 SAST, 06:00Z = 08:00 SAST.
 */

const mem = createMemoryFirestore();
const publishCallback = vi.fn();
const sendSms = vi.fn();
const maybeSendReviewRequest = vi.fn();
const resolveAgent = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/automations/qstash", () => ({
  publishCallback: (...a: unknown[]) => publishCallback(...a),
}));
vi.mock("@/lib/comms/sms/select", () => ({
  sendSmsVia: (...a: unknown[]) => sendSms(...a),
}));
vi.mock("@/lib/server/usage-meter", () => ({
  checkQuota: async () => ({ allowed: true }),
  recordUsage: async () => undefined,
}));
vi.mock("@/lib/server/sub-account-secrets", () => ({
  readSubAccountSecret: async () => "token",
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async () => undefined,
  getConversationControls: async () => ({ botMode: "auto", botPausedUntilMs: null, loopResetAtMs: null }),
}));
vi.mock("@/lib/comms/ai/agent", () => ({
  resolveAgent: (...a: unknown[]) => resolveAgent(...a),
}));
vi.mock("@/lib/reviews/request", () => ({
  maybeSendReviewRequest: (...a: unknown[]) => maybeSendReviewRequest(...a),
}));

const { holdForQuietHours } = await import("./quiet-hours-hold");
const { releaseQuietHoursHold } = await import("./quiet-hours-release");

const NIGHT = new Date("2026-09-24T21:00:00Z");
const OPEN = new Date("2026-09-25T06:00:00Z");
const HOLD = { retryAfterSec: 9 * 3600, until: OPEN, timezone: "Africa/Johannesburg" };

/** Holds one SMS and returns the NEW hold's id. */
async function holdSms(source: "ai_reply" | "missed_call" = "missed_call"): Promise<string> {
  const before = new Set(mem.list("subAccounts/sa1/quietHoursHolds").map((h) => h.id));
  await holdForQuietHours({
    agencyId: "ag1",
    subAccountId: "sa1",
    payload: { kind: "message", message: { channel: "sms", contactId: "c1", to: "+27821234567", body: "Sorry we missed you", source } },
    hold: HOLD,
  });
  return mem.list("subAccounts/sa1/quietHoursHolds").find((h) => !before.has(h.id))!.id;
}

beforeEach(() => {
  mem.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NIGHT);
  publishCallback.mockReset().mockResolvedValue({ messageId: "q1" });
  sendSms.mockReset().mockResolvedValue({ sid: "SMheld" });
  maybeSendReviewRequest.mockReset().mockResolvedValue({ sent: true });
  resolveAgent.mockReset().mockResolvedValue({ effective: { enabled: true } });
  mem.seed("subAccounts/sa1", {
    name: "Velocity", agencyId: "ag1", smsAgentEnabledByAgency: true, missedCallTextBackEnabledByAgency: true,
    twilioConfig: {
      enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber: "+27110000000",
      missedCall: { enabled: true, forwardTo: "+27110000009" },
    },
    sendWindow: { startHour: 8, endHour: 20, timezone: "Africa/Johannesburg" },
  });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Thandi", phone: "+27821234567" });
});
afterEach(() => vi.useRealTimers());

describe("holding", () => {
  it("parks the send and schedules its release for the end of quiet hours", async () => {
    const id = await holdSms();
    expect(mem.read(`subAccounts/sa1/quietHoursHolds/${id}`)).toMatchObject({ status: "pending", contactId: "c1" });
    expect(publishCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/api/comms/quiet-hours/release",
        body: { subAccountId: "sa1", holdId: id },
        delaySeconds: 9 * 3600,
      }),
    );
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("says so on the timeline when the release cannot be scheduled", async () => {
    publishCallback.mockResolvedValue(null);
    const id = await holdSms();
    expect(mem.read(`subAccounts/sa1/quietHoursHolds/${id}`)?.status).toBe("failed");
    const [activity] = mem.list("contacts/c1/activities");
    expect(activity.content).toMatch(/will NOT be sent/);
  });
});

describe("releasing", () => {
  it("sends once the window is open and writes the thread row", async () => {
    const id = await holdSms();
    vi.setSystemTime(OPEN);
    await expect(releaseQuietHoursHold("sa1", id)).resolves.toEqual({ outcome: "released" });
    expect(sendSms).toHaveBeenCalledOnce();
    expect(mem.read("contacts/c1/messages/SMheld")).toMatchObject({ direction: "outbound", body: "Sorry we missed you" });
    expect(mem.read(`subAccounts/sa1/quietHoursHolds/${id}`)?.status).toBe("released");
  });

  it("re-checks opt-out at release: a contact who opted out meanwhile gets nothing", async () => {
    const id = await holdSms();
    await mem.db.doc("contacts/c1").update({ smsOptedOut: true });
    vi.setSystemTime(OPEN);
    await expect(releaseQuietHoursHold("sa1", id)).resolves.toEqual({ outcome: "skipped", reason: "opted_out" });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("never sends twice on a redelivery", async () => {
    const id = await holdSms();
    vi.setSystemTime(OPEN);
    await releaseQuietHoursHold("sa1", id);
    await expect(releaseQuietHoursHold("sa1", id)).resolves.toEqual({ outcome: "skipped", reason: "status:released" });
    expect(sendSms).toHaveBeenCalledOnce();
  });

  it("holds again, unsent, when it is still quiet hours at release", async () => {
    const id = await holdSms();
    await expect(releaseQuietHoursHold("sa1", id)).resolves.toEqual({ outcome: "skipped", reason: "held_again" });
    expect(sendSms).not.toHaveBeenCalled();
    expect(mem.list("subAccounts/sa1/quietHoursHolds").filter((d) => d.status === "pending")).toHaveLength(1);
  });

  it("re-runs a held review request through the whole dispatcher", async () => {
    const request = { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", trigger: "deal_completed" as const };
    await holdForQuietHours({ agencyId: "ag1", subAccountId: "sa1", payload: { kind: "review_request", request }, hold: HOLD });
    const id = mem.list("subAccounts/sa1/quietHoursHolds")[0].id;
    vi.setSystemTime(OPEN);
    await expect(releaseQuietHoursHold("sa1", id)).resolves.toEqual({ outcome: "released" });
    expect(maybeSendReviewRequest).toHaveBeenCalledWith(request);
  });

  it("sends nothing when the switch its sender checked was turned off meanwhile", async () => {
    const id = await holdSms("missed_call");
    const sub = mem.read("subAccounts/sa1")!;
    mem.seed("subAccounts/sa1", { ...sub, missedCallTextBackEnabledByAgency: false });
    vi.setSystemTime(OPEN);
    await expect(releaseQuietHoursHold("sa1", id)).resolves.toEqual({ outcome: "skipped", reason: "mctb_disabled" });

    const ai = await holdSms("ai_reply");
    resolveAgent.mockResolvedValue({ effective: { enabled: false } });
    await expect(releaseQuietHoursHold("sa1", ai)).resolves.toEqual({ outcome: "skipped", reason: "ai_disabled" });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("sends nothing when the contact's number changed meanwhile", async () => {
    const id = await holdSms();
    await mem.db.doc("contacts/c1").update({ phone: "+27829999999" });
    vi.setSystemTime(OPEN);
    await expect(releaseQuietHoursHold("sa1", id)).resolves.toEqual({ outcome: "skipped", reason: "number_changed" });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("a throw after the claim hands the hold back and says so, so it is retried, never stuck", async () => {
    const id = await holdSms("ai_reply");
    resolveAgent.mockRejectedValueOnce(new Error("14 UNAVAILABLE"));
    vi.setSystemTime(OPEN);
    await expect(releaseQuietHoursHold("sa1", id)).rejects.toThrow("UNAVAILABLE");
    expect(mem.read(`subAccounts/sa1/quietHoursHolds/${id}`)?.status).toBe("pending");
    expect(mem.read(`contacts/c1/activities/qh_${id}_retry`)?.content).toMatch(/will be retried/);
    // The QStash retry then goes through, once.
    await expect(releaseQuietHoursHold("sa1", id)).resolves.toEqual({ outcome: "released" });
    expect(sendSms).toHaveBeenCalledOnce();
  });
});

describe("held AI replies", () => {
  it("a newer held reply supersedes the older one: one reply at window open, not a burst", async () => {
    const first = await holdSms("ai_reply");
    vi.setSystemTime(new Date(NIGHT.getTime() + 60_000));
    const second = await holdSms("ai_reply");
    expect(mem.read(`subAccounts/sa1/quietHoursHolds/${first}`)?.status).toBe("superseded");
    vi.setSystemTime(OPEN);
    await expect(releaseQuietHoursHold("sa1", first)).resolves.toEqual({ outcome: "skipped", reason: "status:superseded" });
    await expect(releaseQuietHoursHold("sa1", second)).resolves.toEqual({ outcome: "released" });
    expect(sendSms).toHaveBeenCalledOnce();
  });

  it("is dropped when the contact wrote again after it was held", async () => {
    const id = await holdSms("ai_reply");
    mem.seed("contacts/c1/messages/in2", { direction: "inbound", body: "hello?", createdAt: new Date(NIGHT.getTime() + 60_000) });
    vi.setSystemTime(OPEN);
    await expect(releaseQuietHoursHold("sa1", id)).resolves.toEqual({ outcome: "skipped", reason: "newer_inbound" });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("names the release time in the workspace's timezone, on one row per hold", async () => {
    const id = await holdSms();
    expect(mem.read(`contacts/c1/activities/qh_${id}`)?.content).toMatch(/08:00 \(Africa\/Johannesburg\)/);
  });
});
