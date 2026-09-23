import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deliverTo, mem, seedConnection, seedOrder, SA, session } from "@/test/stripe-orders-harness";

/**
 * A card deposit that lands after the payment hold expired: expire-step has
 * cancelled the booking and released its slot, so mark-paid refuses it and
 * the paid order is flagged on `order.attention` for a refund — never
 * silently dropped, and never confused with a replay of our own success.
 * Real expire-step route + real webhook → reconciler → mark-paid.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/stripe-orders-harness")).adminMock());
vi.mock("@/lib/automations/qstash", () => ({ verifyQStashSignature: async () => true }));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => {}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: vi.fn(async () => {}) }));

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-32-characters-long";
const deliver = deliverTo((await import("./route")).POST);
const { POST: expire } = await import("@/app/api/events/payment/expire-step/route");

const runExpire = () =>
  expire(
    new Request("http://x/api/events/payment/expire-step", {
      method: "POST",
      headers: { "Upstash-Signature": "sig" },
      body: JSON.stringify({ eventId: "ev1" }),
    }),
  );
const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });
const pay = () => deliver("checkout.session.completed", session("cs_o1"));
const attention = () => mem.read("orders/o1")!.attention ?? null;
const status = () => mem.read("events/ev1")!.status;

beforeEach(() => {
  mem.clear();
  seedConnection();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const start = new Date(Date.now() + 2 * 24 * 3600_000);
  mem.seed("events/ev1", {
    subAccountId: SA,
    agencyId: "ag1",
    status: "awaiting_payment",
    contactId: null,
    startAt: ts(start),
    endAt: ts(new Date(start.getTime() + 1800_000)),
  });
  seedOrder("o1", { source: "booking_deposit", quoteId: null, eventId: "ev1" });
});
afterEach(() => vi.restoreAllMocks());

describe("a deposit paid after the hold expired", () => {
  it("leaves the booking cancelled and flags the paid order for a refund", async () => {
    await runExpire();
    expect((await pay()).status).toBe(200);
    expect(status()).toBe("cancelled");
    expect(attention()).toMatch(/no longer awaiting payment \(cancelled\).*refund/);
  });

  it("racing the expiry: either it confirms with no flag, or it is flagged — never both lost", async () => {
    await Promise.all([pay(), runExpire()]);
    if (status() === "cancelled") {
      expect(attention()).toMatch(/cancelled/);
    } else {
      expect(status()).toBe("scheduled");
      expect(mem.read("events/ev1")!.paidOrderId).toBe("o1");
      expect(attention()).toBeNull();
    }
  });

  it("a redelivery of the payment that confirmed it is not flagged", async () => {
    expect((await pay()).status).toBe(200);
    expect(status()).toBe("scheduled");
    expect(mem.read("events/ev1")!.paidOrderId).toBe("o1");
    expect((await deliver("checkout.session.completed", session("cs_o1"), "evt_2")).status).toBe(200);
    expect(attention()).toBeNull();
  });
});
