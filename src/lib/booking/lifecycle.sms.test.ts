import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reminder callbacks carry the page's channel toggles from scheduling
 * time: the step reads the live page first and uses this snapshot only when
 * the page was deleted.
 */

const publishCallback = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn() }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));
vi.mock("@/lib/automations/qstash", () => ({
  publishCallback,
  qstashIsConfigured: () => true,
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));

const { scheduleEventReminders } = await import("./lifecycle");

beforeEach(() => {
  publishCallback.mockReset().mockResolvedValue({ messageId: "m1" });
});

const schedule = (page?: Parameters<typeof scheduleEventReminders>[0]["page"]) =>
  scheduleEventReminders({
    eventId: "evt1",
    startAt: new Date(Date.now() + 48 * 3600_000),
    reminderOffsetsMinutes: [1440, 60],
    rawToken: "tok",
    pendingPayment: false,
    page,
  });

describe("scheduleEventReminders channel snapshot", () => {
  it("carries email, text, page name and timezone in every callback", async () => {
    await schedule({ remindersEnabled: false, smsRemindersEnabled: true, name: "Intro call", timezone: "Africa/Johannesburg" });
    expect(publishCallback).toHaveBeenCalledTimes(2);
    for (const [call] of publishCallback.mock.calls) {
      expect(call.body).toEqual({
        eventId: "evt1",
        offsetMinutes: expect.any(Number),
        token: "tok",
        channels: { email: false, sms: true, pageName: "Intro call", timezone: "Africa/Johannesburg" },
      });
    }
  });

  it("reads a page saved before the text toggle as text off, email on", async () => {
    await schedule({ remindersEnabled: true, name: "Old", timezone: "UTC" });
    expect(publishCallback.mock.calls[0][0].body.channels).toMatchObject({ email: true, sms: false });
  });

  it("sends no snapshot when no page is given", async () => {
    await schedule();
    expect(publishCallback.mock.calls[0][0].body).not.toHaveProperty("channels");
  });
});
