import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A repeat cancel (double click, a second tab, a replayed request) answers
 * 200 but does nothing: the booking.cancelled workflows, webhook, activity
 * row and email ran on the first cancel and must not run again.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: async () => undefined }));

const triggers = vi.fn(async () => undefined);
const webhooks = vi.fn(async () => undefined);
const activities = vi.fn(async () => undefined);
vi.mock("@/lib/booking/lifecycle", async () => ({
  ...(await h()).bookingMocks.lifecycle(),
  fireBookingTrigger: () => triggers(),
  emitBookingWebhook: () => webhooks(),
  recordBookingActivity: () => activities(),
}));

const { mem, resetBookingHarness, seedEvent, seedPage } = await h();
const { POST } = await import("./route");
const { issueEventToken } = await import("@/lib/booking/event-token");

const cancel = (token: string) =>
  POST(new Request("http://x/api", { method: "POST" }), { params: Promise.resolve({ token }) });

let token = "";
beforeEach(() => {
  resetBookingHarness();
  triggers.mockClear();
  webhooks.mockClear();
  activities.mockClear();
  seedPage("p");
  const issued = issueEventToken("e1");
  token = issued.token;
  seedEvent("e1", "10:00", "10:30", {
    bookingPageSlug: "p",
    contactId: "c1",
    publicTokenHash: issued.hash,
  });
});
afterEach(() => vi.useRealTimers());

describe("visitor cancel", () => {
  it("runs its side effects once, however often it is repeated", async () => {
    expect((await cancel(token)).status).toBe(200);
    expect((await cancel(token)).status).toBe(200);
    await Promise.all([cancel(token), cancel(token)]);
    expect(mem.read("events/e1")?.status).toBe("cancelled");
    expect(triggers).toHaveBeenCalledTimes(1);
    expect(webhooks).toHaveBeenCalledTimes(1);
    expect(activities).toHaveBeenCalledTimes(1);
  });

  it("does nothing to a booking that was already cancelled some other way", async () => {
    mem.seed("events/e1", { ...mem.read("events/e1"), status: "cancelled", cancelReason: "payment_expired" });
    expect((await cancel(token)).status).toBe(200);
    expect(triggers).not.toHaveBeenCalled();
    expect(webhooks).not.toHaveBeenCalled();
    expect(mem.read("events/e1")?.cancelReason).toBe("payment_expired");
  });
});
