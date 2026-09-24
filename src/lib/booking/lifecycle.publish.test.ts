import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * publishCallback never throws — it resolves null when a reminder or the
 * payment auto-expire could not be queued. That must be logged with the
 * event it belongs to, not swallowed.
 */

const publishCallback = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn() }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));
vi.mock("@/lib/automations/qstash", () => ({
  publishCallback,
  qstashIsConfigured: () => true,
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));

const { scheduleEventReminders, schedulePaymentAutoExpire } = await import("./lifecycle");

let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  publishCallback.mockReset().mockResolvedValue({ messageId: "m1" });
  vi.restoreAllMocks();
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

const remind = () =>
  scheduleEventReminders({
    eventId: "evt1",
    startAt: new Date(Date.now() + 48 * 3600_000),
    reminderOffsetsMinutes: [1440, 60],
    rawToken: "tok",
    pendingPayment: false,
  });

describe("scheduleEventReminders — publish resolves null", () => {
  it("logs each reminder that was not queued, with the event and offset", async () => {
    publishCallback.mockResolvedValueOnce(null);
    await remind();
    expect(publishCallback).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "[booking/lifecycle] reminder not queued event=evt1 offset=1440min",
    );
  });

  it("logs nothing when every reminder is queued", async () => {
    await remind();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("schedulePaymentAutoExpire — publish resolves null", () => {
  it("logs the event whose hold will not auto-expire", async () => {
    publishCallback.mockResolvedValueOnce(null);
    await schedulePaymentAutoExpire({ eventId: "evt2", expiresAt: new Date(Date.now() + 3600_000) });
    expect(error).toHaveBeenCalledWith(
      "[booking/lifecycle] payment auto-expire not queued event=evt2",
    );
  });

  it("logs nothing when it is queued", async () => {
    await schedulePaymentAutoExpire({ eventId: "evt2", expiresAt: new Date(Date.now() + 3600_000) });
    expect(error).not.toHaveBeenCalled();
  });
});
