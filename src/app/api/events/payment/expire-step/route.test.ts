import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The payment-hold expiry is scheduled ONCE per booking, and nothing sweeps
 * missed ones. So a transient failure must answer 5xx (QStash retries), while
 * "nothing to do" (already paid / cancelled) stays 200.
 */

const runTransaction = vi.fn();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({ doc: (id: string) => ({ id }) }),
    runTransaction,
  }),
}));
vi.mock("@/lib/automations/qstash", () => ({ verifyQStashSignature: async () => true }));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: vi.fn() }));

const { POST } = await import("./route");

const call = () =>
  POST(
    new Request("http://x/api/events/payment/expire-step", {
      method: "POST",
      headers: { "Upstash-Signature": "sig" },
      body: JSON.stringify({ eventId: "e1" }),
    }),
  );

beforeEach(() => {
  runTransaction.mockReset();
});

describe("expire-step", () => {
  it("answers 5xx on a transaction error so QStash retries the one scheduled expiry", async () => {
    runTransaction.mockRejectedValue(Object.assign(new Error("14 UNAVAILABLE"), { code: 14 }));
    const res = await call();
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("answers 200 when there is nothing to expire (already paid or cancelled)", async () => {
    runTransaction.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: "no_action" });
  });
});
