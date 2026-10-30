import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

import {
  KEY,
  OTHER_KEY,
  OTHER_SA,
  SA,
  mem,
  refused,
  seedAttempt,
  seedSub,
  stubPaystack,
  verified,
  type PaystackCall,
} from "@/test/paystack-links-harness";

/**
 * The lifetime of unpaid Paystack buy-page orders, through the real sweep,
 * reconciler and attempt flagging over an in-memory Firestore. Only Paystack's
 * HTTP API and the order fan-out are stubbed.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => {}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
const sendEmail = vi.hoisted(() => vi.fn(async () => ({ id: "m1" })));
vi.mock("@/lib/comms/resend", async (orig) => ({ ...(await orig<typeof import("@/lib/comms/resend")>()), sendEmail }));

const { expireStalePaystackOrders, EXPIRY_BATCH, PAYSTACK_ORDER_LIFETIME_MS } = await import("./paystack-order-expiry");
const { flagStaleAttempts } = await import("@/lib/server/payment-attempts");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-30T12:00:00Z");
const OLD = new Date(NOW.getTime() - 25 * HOUR);

function seedBuy(
  n: number,
  createdAt: Date = OLD,
  orderOver: Record<string, unknown> = {},
  tenant: { sa: string; key: string } = { sa: SA, key: KEY },
) {
  const id = `ord${n}`;
  mem.seed(`orders/${id}`, {
    agencyId: "ag1",
    subAccountId: tenant.sa,
    contactId: null,
    source: "product_link",
    status: "pending",
    currency: "zar",
    totalCents: 49_900,
    subtotalCents: 49_900,
    refundedCents: 0,
    stripeCheckoutSessionId: "",
    paystackReference: `po-${id}`,
    buyerEmail: "buyer@example.com",
    lineItems: [{ productId: "p1", name: "Fibre guide", description: "", unitPriceCents: 49_900, quantity: 1, isBump: false }],
    ...orderOver,
  });
  seedAttempt(`po-${id}`, {
    paymentLinkId: "",
    orderId: id,
    amountCents: 49_900,
    createdAt,
    subAccountId: tenant.sa,
    secretKey: tenant.key,
  });
  return `po-${id}`;
}
const order = (n: number) => mem.read(`orders/ord${n}`)!;
const attempt = (n: number) => mem.read(`paymentAttempts/po-ord${n}`)!;

let verifyAnswer: (reference: string, auth?: string | null) => ReturnType<typeof verified> | "network-error" | { status: number; body: unknown };
let calls: PaystackCall[];

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "shop@example.com";
  seedSub();
  verifyAnswer = (reference) => verified({ reference, status: "abandoned", amount: 49_900 });
  calls = stubPaystack((c) => verifyAnswer(c.path.split("/").pop()!, c.auth));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("an abandoned buy", () => {
  it("expires after 24 hours: the order is expired, the attempt refused", async () => {
    seedBuy(1);
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 1, expired: 1 });
    expect(order(1)).toMatchObject({ status: "expired" });
    expect(attempt(1)).toMatchObject({ state: "refused" });
    expect(calls).toEqual([expect.objectContaining({ path: "/transaction/verify/po-ord1", auth: `Bearer ${KEY}` })]);
  });

  it.each([
    ["failed", () => verified({ reference: "po-ord1", status: "failed" })],
    ["reversed", () => verified({ reference: "po-ord1", status: "reversed" })],
    ["unknown to Paystack", () => refused(404, "Transaction reference not found")],
  ])("%s also expires it", async (_name, answer) => {
    seedBuy(1);
    verifyAnswer = answer;
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ expired: 1 });
    expect(order(1)).toMatchObject({ status: "expired" });
  });

  it("younger than 24 hours is not even asked about", async () => {
    seedBuy(1, new Date(NOW.getTime() - (PAYSTACK_ORDER_LIFETIME_MS - HOUR)));
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 0, expired: 0 });
    expect(order(1)).toMatchObject({ status: "pending" });
    expect(calls).toHaveLength(0);
  });

  it("still in progress, or Paystack unreachable: left open for the next run", async () => {
    seedBuy(1);
    verifyAnswer = (reference) => verified({ reference, status: "ongoing" });
    await expireStalePaystackOrders(NOW);
    verifyAnswer = () => "network-error";
    await expect(expireStalePaystackOrders(NOW)).rejects.toThrow(/failed/);
    expect(order(1)).toMatchObject({ status: "pending" });
    expect(attempt(1)).toMatchObject({ state: "open" });
  });

  it("a flagged or held order is never expired by the sweep", async () => {
    seedBuy(1, OLD, { attention: "Paid, check this", attentionOpen: true });
    await expireStalePaystackOrders(NOW);
    expect(order(1)).toMatchObject({ status: "pending", attentionOpen: true });
  });

  it("an attempt opened with a key the workspace no longer holds is not this sweep's to judge", async () => {
    seedBuy(1);
    seedSub(SA, OTHER_KEY);
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 0, expired: 0 });
    expect(calls).toHaveLength(0);
    expect(attempt(1)).toMatchObject({ state: "open" });
  });

  it("is a no-op the second time", async () => {
    seedBuy(1);
    await expireStalePaystackOrders(NOW);
    calls.length = 0;
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("a stuck attempt", () => {
  const ongoing = (reference: string) => verified({ reference, status: "ongoing", amount: 49_900 });

  it("Paystack still calls it ongoing after 7 days: closed like an abandoned one", async () => {
    seedBuy(1, new Date(NOW.getTime() - 8 * DAY));
    verifyAnswer = ongoing;
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 1, expired: 1 });
    expect(order(1)).toMatchObject({ status: "expired" });
    expect(attempt(1)).toMatchObject({ state: "refused" });
  });

  it("under 7 days it waits for the next run", async () => {
    seedBuy(1, new Date(NOW.getTime() - 6 * DAY));
    verifyAnswer = ongoing;
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 1, expired: 0 });
    expect(order(1)).toMatchObject({ status: "pending" });
    expect(attempt(1)).toMatchObject({ state: "open" });
  });

  it("30 stuck attempts no longer starve a newer abandoned one", async () => {
    for (let i = 1; i <= 30; i += 1) seedBuy(i, new Date(NOW.getTime() - 8 * DAY - (100 - i) * 1000));
    seedBuy(31, OLD);
    verifyAnswer = (reference) =>
      reference === "po-ord31" ? verified({ reference, status: "abandoned" }) : ongoing(reference);
    await expireStalePaystackOrders(NOW);
    expect(order(31)).toMatchObject({ status: "pending" });
    await expireStalePaystackOrders(NOW);
    expect(order(31)).toMatchObject({ status: "expired" });
    for (let i = 1; i <= 30; i += 1) expect(attempt(i)).toMatchObject({ state: "refused" });
  });
});

describe("one workspace cannot starve the others", () => {
  const B = { sa: OTHER_SA, key: OTHER_KEY };

  beforeEach(() => seedSub(OTHER_SA, OTHER_KEY));

  it("25 old buys under a revoked key (401) do not stop another workspace's abandoned buy being asked", async () => {
    for (let i = 1; i <= 25; i += 1) seedBuy(i, new Date(OLD.getTime() - (100 - i) * 1000));
    seedBuy(100, OLD, {}, B);
    verifyAnswer = (reference, auth) =>
      auth === `Bearer ${KEY}` ? refused(401, "Invalid key") : verified({ reference, status: "abandoned" });

    const summary = await expireStalePaystackOrders(NOW);
    expect(order(100)).toMatchObject({ status: "expired" });
    expect(attempt(100)).toMatchObject({ state: "refused" });
    // The revoked key cost three calls, not twenty-five.
    expect(calls.filter((c) => c.auth === `Bearer ${KEY}`)).toHaveLength(3);
    expect(summary).toMatchObject({ checked: 4, errors: 3, expired: 1, skipped: 22 });
    expect(order(1)).toMatchObject({ status: "pending" });
  });

  it("buys stuck 'ongoing' (under 7 days) are asked three times a run, not all", async () => {
    for (let i = 1; i <= 30; i += 1) seedBuy(i, new Date(OLD.getTime() - (100 - i) * 1000));
    seedBuy(100, OLD, {}, B);
    verifyAnswer = (reference, auth) =>
      verified({ reference, status: auth === `Bearer ${KEY}` ? "ongoing" : "abandoned" });
    await expireStalePaystackOrders(NOW);
    expect(order(100)).toMatchObject({ status: "expired" });
    expect(calls.filter((c) => c.auth === `Bearer ${KEY}`)).toHaveLength(3);
  });

  it("reads past the first page: another workspace's buy behind 120 stuck rows is still reached", async () => {
    for (let i = 1; i <= 120; i += 1) seedBuy(i, new Date(OLD.getTime() - (1000 - i) * 1000));
    seedBuy(500, OLD, {}, B);
    verifyAnswer = (reference, auth) =>
      verified({ reference, status: auth === `Bearer ${KEY}` ? "ongoing" : "abandoned" });
    await expireStalePaystackOrders(NOW);
    expect(order(500)).toMatchObject({ status: "expired" });
  });

  it("a workspace whose first asks resolve is not capped: its 25 abandoned buys all expire", async () => {
    for (let i = 1; i <= 25; i += 1) seedBuy(i, new Date(OLD.getTime() - (100 - i) * 1000));
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 25, expired: 25 });
  });
});

describe("the run's summary", () => {
  it("counts an order expired only when the sweep actually changed it", async () => {
    seedBuy(1, OLD, { attention: "Held, check", attentionOpen: true });
    seedBuy(2);
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 2, expired: 1 });
    expect(order(1)).toMatchObject({ status: "pending" });
  });

  it("counts attempts skipped for their key, apart from the Paystack calls", async () => {
    seedBuy(1);
    seedBuy(2);
    seedSub(SA, OTHER_KEY);
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 0, skipped: 2, errors: 0 });
  });

  it("some asks failing is reported, not thrown", async () => {
    seedBuy(1, new Date(OLD.getTime() - 1000));
    seedBuy(2);
    verifyAnswer = (reference) => (reference === "po-ord1" ? "network-error" : verified({ reference, status: "abandoned" }));
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 2, errors: 1, expired: 1 });
  });

  it("every ask failing throws, so the housekeeping route answers 500", async () => {
    seedBuy(1);
    seedBuy(2);
    verifyAnswer = () => "network-error";
    await expect(expireStalePaystackOrders(NOW)).rejects.toThrow(/all 2 Paystack ask\(s\) failed/);
    expect(order(1)).toMatchObject({ status: "pending" });
  });

  it("nothing to ask is not a failure", async () => {
    verifyAnswer = () => "network-error";
    await expect(expireStalePaystackOrders(NOW)).resolves.toMatchObject({ checked: 0, errors: 0 });
  });
});

describe("a buy paid after all", () => {
  it("is reconciled like a webhook: paid, one email (also hears a webhook that was never registered)", async () => {
    seedBuy(1);
    verifyAnswer = (reference) => verified({ reference, status: "success", amount: 49_900 });
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 1, reconciled: 1, expired: 0 });
    await flushAfterResponse();
    expect(order(1)).toMatchObject({ status: "paid" });
    expect(attempt(1)).toMatchObject({ state: "settled" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a payment for another amount is held, not paid and not expired", async () => {
    seedBuy(1);
    verifyAnswer = (reference) => verified({ reference, status: "success", amount: 100 });
    await expireStalePaystackOrders(NOW);
    expect(order(1)).toMatchObject({ status: "pending", attentionOpen: true });
    expect(order(1).heldAt).toBeTruthy();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a payment that lands after the order expired is flagged, never dropped", async () => {
    seedBuy(1);
    await expireStalePaystackOrders(NOW);
    verifyAnswer = (reference) => verified({ reference, status: "success", amount: 49_900 });
    const { reconcilePaystackCharge } = await import("@/lib/paystack/payment-link-reconciler");
    await reconcilePaystackCharge({ subAccountId: SA, secretKey: KEY, reference: "po-ord1" });
    expect(order(1)).toMatchObject({ status: "expired", attentionOpen: true });
    expect(order(1).attention).toMatch(/already expired/);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("the batch", () => {
  it(`asks Paystack about at most ${EXPIRY_BATCH} attempts a run, oldest first`, async () => {
    for (let i = 1; i <= EXPIRY_BATCH + 5; i += 1) seedBuy(i, new Date(OLD.getTime() - (100 - i) * 1000));
    const first = await expireStalePaystackOrders(NOW);
    expect(first).toMatchObject({ checked: EXPIRY_BATCH, expired: EXPIRY_BATCH });
    expect(calls).toHaveLength(EXPIRY_BATCH);
    expect(order(1)).toMatchObject({ status: "expired" });
    expect(order(EXPIRY_BATCH + 5)).toMatchObject({ status: "pending" });
    // The rest wait for the next run.
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 5, expired: 5 });
  });

  it("stops asking when the run's time budget is spent", async () => {
    seedBuy(1);
    seedBuy(2);
    expect(await expireStalePaystackOrders(NOW, -1)).toMatchObject({ checked: 0, overBudget: 2 });
    expect(calls).toHaveLength(0);
  });
});

describe("a key change", () => {
  it("after expiry flags nothing: the expired buys left the open set", async () => {
    seedBuy(1);
    await expireStalePaystackOrders(NOW);
    await flagStaleAttempts(SA, null);
    expect(attempt(1)).toMatchObject({ state: "refused" });
    expect(order(1).attention ?? null).toBeNull();
  });

  it("before expiry still flags an open buy, on the order too", async () => {
    seedBuy(1, new Date(NOW.getTime() - HOUR));
    await flagStaleAttempts(SA, null);
    expect(attempt(1)).toMatchObject({ state: "flagged" });
    expect(order(1)).toMatchObject({ attentionOpen: true });
  });
});
