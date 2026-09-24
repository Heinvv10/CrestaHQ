import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * publishCallback never throws — it resolves null when a delivery could not
 * be queued. The pending delivery row would then never run, so it must be
 * marked failed with the reason (the delivery log shows it; Redeliver
 * replays it), and the miss logged with the event + delivery.
 */

vi.mock("server-only", () => ({}));
const publishCallback = vi.hoisted(() => vi.fn());
const updateDelivery = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/automations/qstash", () => ({ publishCallback }));
vi.mock("@/lib/firestore/webhook-events", () => ({
  createEvent: async () => ({ id: "ev1" }),
  createDelivery: async () => ({ id: "dl1" }),
  updateDelivery,
}));
vi.mock("@/lib/firestore/webhook-subscriptions", () => ({
  findMatchingSubscriptions: async () => [{ id: "sub1", url: "https://hook.test" }],
}));
vi.mock("@/lib/push/events", () => ({ dispatchPushForWebhookEvent: async () => {} }));

const { emitWebhookEvent, scheduleDeliveryRetry } = await import("./dispatch");

let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.restoreAllMocks();
  publishCallback.mockReset().mockResolvedValue({ messageId: "m1" });
  updateDelivery.mockClear();
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

const FAILED = {
  status: "failed",
  errorMessage: "Could not schedule this delivery (queue publish failed). Redeliver to retry.",
};

describe("emitWebhookEvent — first delivery publish resolves null", () => {
  it("marks the delivery failed and logs it", async () => {
    publishCallback.mockResolvedValue(null);
    await emitWebhookEvent({
      subAccountId: "sa1",
      agencyId: "ag1",
      mode: "test",
      type: "contact.created",
      payload: {},
    });
    expect(publishCallback).toHaveBeenCalledWith(
      expect.objectContaining({ deduplicationId: "ev1_dl1", delaySeconds: 0 }),
    );
    expect(updateDelivery).toHaveBeenCalledWith("sa1", "ev1", "dl1", FAILED);
    expect(error).toHaveBeenCalledWith(
      "[webhooks/dispatch] delivery not queued sa=sa1 event=ev1 delivery=dl1",
    );
  });
});

describe("scheduleDeliveryRetry", () => {
  const retry = () =>
    scheduleDeliveryRetry({ subAccountId: "sa1", eventId: "ev1", deliveryId: "dl2", delaySeconds: 60 });

  it("marks the retry row failed and returns false when the publish resolves null", async () => {
    publishCallback.mockResolvedValue(null);
    expect(await retry()).toBe(false);
    expect(updateDelivery).toHaveBeenCalledWith("sa1", "ev1", "dl2", FAILED);
  });

  it("leaves the row pending and returns true when queued", async () => {
    expect(await retry()).toBe(true);
    expect(updateDelivery).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
