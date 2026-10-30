import { createHmac } from "node:crypto";
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
 * Seam test: the REAL webhook route → the REAL Paystack reconciler → the REAL
 * `settleProductLinkPayment` and `finishPaidProductLinkOrder` (the same tail
 * the Stripe path runs) → the REAL order confirmation, over an in-memory
 * Firestore. Only Paystack's HTTP API, the workflow/webhook fan-out (counted
 * to prove "fired once") and the outbound mail are stubbed.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
const fireWorkflowTrigger = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
const sendEmail = vi.hoisted(() => vi.fn(async (_m: { to: string; subject: string; text: string }) => ({ id: "m1" })));
vi.mock("@/lib/comms/resend", async (orig) => ({
  ...(await orig<typeof import("@/lib/comms/resend")>()),
  sendEmail,
}));

const { POST } = await import("./route");

const REF = "po-ord1";
const DOWNLOAD = "https://files.example.com/guide.pdf";

function deliver(opts: { reference?: string; key?: string; sa?: string } = {}) {
  const body = JSON.stringify({ event: "charge.success", data: { reference: opts.reference ?? REF } });
  const signature = createHmac("sha512", opts.key ?? KEY).update(body).digest("hex");
  return POST(
    new Request(`http://app.local/api/webhooks/paystack/sa/${opts.sa ?? SA}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paystack-signature": signature },
      body,
    }),
    { params: Promise.resolve({ subAccountId: opts.sa ?? SA }) },
  );
}

function seedOrder(over: Record<string, unknown> = {}, id = "ord1") {
  mem.seed(`orders/${id}`, {
    agencyId: "ag1",
    subAccountId: SA,
    contactId: null,
    checkoutPageId: null,
    quoteId: null,
    source: "product_link",
    status: "pending",
    currency: "zar",
    subtotalCents: 49_900,
    totalCents: 49_900,
    refundedCents: 0,
    stripeCheckoutSessionId: "",
    stripePaymentIntentId: null,
    paystackReference: `po-${id}`,
    livemode: false,
    buyerEmail: "buyer@example.com",
    buyerName: null,
    productLinkProductId: "p1",
    lineItems: [{ productId: "p1", name: "Fibre guide", description: "", unitPriceCents: 49_900, quantity: 1, isBump: false }],
    deliveries: [{ productId: "p1", delivery: { type: "download", url: DOWNLOAD, label: "Get the guide" } }],
    ...over,
  });
}
const seedOrderAttempt = (over: Record<string, unknown> = {}) =>
  seedAttempt(REF, { paymentLinkId: "", orderId: "ord1", amountCents: 49_900, ...over });

const order = () => mem.read("orders/ord1")!;
const attempt = () => mem.read(`paymentAttempts/${REF}`)!;
const paidEvents = () =>
  (fireWorkflowTrigger.mock.calls as unknown as [{ type: string }][]).filter(([a]) => a.type === "order.paid");

let verifyAnswer: (call: PaystackCall) => ReturnType<typeof verified> | "network-error" | { status: number; body: unknown };
let calls: PaystackCall[];

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "shop@example.com";
  seedSub();
  seedOrder();
  seedOrderAttempt();
  verifyAnswer = () => verified({ reference: REF, amount: 49_900 });
  calls = stubPaystack((c) => verifyAnswer(c));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("charge.success → buy-page order paid", () => {
  it("pays the order after re-verifying with THIS tenant's key, and runs the whole tail once", async () => {
    const res = await deliver();
    expect(res.status).toBe(200);
    await flushAfterResponse();

    expect(order()).toMatchObject({ status: "paid", buyerEmail: "buyer@example.com" });
    expect(order().attention ?? null).toBeNull();
    expect(attempt()).toMatchObject({ state: "settled" });
    expect(calls).toEqual([
      expect.objectContaining({ method: "GET", path: `/transaction/verify/${REF}`, auth: `Bearer ${KEY}` }),
    ]);
    // The buyer's contact, linked once.
    const contacts = mem.list("contacts");
    expect(contacts).toEqual([expect.objectContaining({ email: "buyer@example.com", subAccountId: SA })]);
    expect(order().contactId).toBe(contacts[0].id);
    // order.paid saw the contact; one confirmation with the amount and the download.
    expect(paidEvents()).toEqual([[expect.objectContaining({ contactId: contacts[0].id })]]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe("buyer@example.com");
    expect(mail.text).toMatch(/Total paid: R\s499\.00 ZAR/);
    expect(mail.text).toContain(DOWNLOAD);
    expect(order().confirmationEmail).toMatchObject({ state: "sent" });
  });

  it("a replayed event is a no-op: one paid order, one contact, one event, ONE email", async () => {
    await deliver();
    await flushAfterResponse();
    const version = (await mem.db.doc("orders/ord1").get()).version;
    const attemptVersion = (await mem.db.doc(`paymentAttempts/${REF}`).get()).version;
    for (let i = 0; i < 2; i++) {
      const res = await deliver();
      expect(res.status).toBe(200);
      await flushAfterResponse();
    }
    expect(mem.list("contacts")).toHaveLength(1);
    expect(paidEvents()).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((await mem.db.doc("orders/ord1").get()).version).toBe(version);
    expect((await mem.db.doc(`paymentAttempts/${REF}`).get()).version).toBe(attemptVersion);
  });

  it("overlapping deliveries of one payment still produce one paid order and one email", async () => {
    const results = await Promise.all([deliver(), deliver(), deliver()]);
    // One may answer 503 while another holds the contact lease; Paystack redelivers.
    expect(results.every((r) => r.status === 200 || r.status === 503)).toBe(true);
    await flushAfterResponse();
    await deliver();
    await flushAfterResponse();
    expect(order()).toMatchObject({ status: "paid" });
    expect(mem.list("contacts")).toHaveLength(1);
    expect(paidEvents()).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a crash after the paid commit is repaired by the redelivery: the tail runs once", async () => {
    // Paid, but the contact, the order.paid events and the email never ran.
    seedOrder({ status: "paid" });
    expect((await deliver()).status).toBe(200);
    await flushAfterResponse();
    expect(attempt()).toMatchObject({ state: "settled" });
    expect(mem.list("contacts")).toHaveLength(1);
    expect(paidEvents()).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    await deliver();
    await flushAfterResponse();
    expect(paidEvents()).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("customer-borne fees: Paystack's amount is request + fees, requested_amount is what must match", async () => {
    verifyAnswer = () => verified({ reference: REF, amount: 51_000, requested_amount: 49_900 });
    await deliver();
    expect(order()).toMatchObject({ status: "paid" });
  });
});

describe("a payment that does not match the order is held, never paid", () => {
  const heldAndFlagged = async (pattern: RegExp) => {
    await flushAfterResponse();
    expect(order()).toMatchObject({ status: "pending", attentionOpen: true });
    expect(order().heldAt).toBeTruthy();
    expect(order().attention).toMatch(pattern);
    expect(attempt()).toMatchObject({ state: "flagged" });
    expect(attempt().reason).toMatch(pattern);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(paidEvents()).toHaveLength(0);
    expect(mem.list("contacts")).toHaveLength(0);
  };

  it("a different amount", async () => {
    verifyAnswer = () => verified({ reference: REF, amount: 100 });
    expect((await deliver()).status).toBe(200);
    await heldAndFlagged(/differs from this order/);
  });

  it("a different currency", async () => {
    verifyAnswer = () => verified({ reference: REF, amount: 49_900, currency: "USD" });
    expect((await deliver()).status).toBe(200);
    await heldAndFlagged(/differs from this order/);
  });

  it("an amount below what was requested (a partial payment)", async () => {
    verifyAnswer = () => verified({ reference: REF, amount: 40_000, requested_amount: 49_900 });
    expect((await deliver()).status).toBe(200);
    await heldAndFlagged(/differs from this order/);
  });

  it("a live-mode payment for a test-mode checkout", async () => {
    verifyAnswer = () => verified({ reference: REF, amount: 49_900, domain: "live" });
    expect((await deliver()).status).toBe(200);
    await heldAndFlagged(/live-mode payment arrived for a test-mode checkout/);
  });

  it("stays held: a later matching delivery, or a replay, never pays it", async () => {
    verifyAnswer = () => verified({ reference: REF, amount: 100 });
    await deliver();
    verifyAnswer = () => verified({ reference: REF, amount: 49_900 });
    expect((await deliver()).status).toBe(200);
    await flushAfterResponse();
    expect(order()).toMatchObject({ status: "pending" });
    expect(order().heldAt).toBeTruthy();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("trust boundaries", () => {
  it("a key other than the attempt's → flagged on the attempt AND the order, nothing paid", async () => {
    seedSub(SA, OTHER_KEY);
    const res = await deliver({ key: OTHER_KEY });
    expect(res.status).toBe(200);
    expect(order()).toMatchObject({ status: "pending", attentionOpen: true });
    expect(order().attention).toMatch(/different key/);
    expect(attempt()).toMatchObject({ state: "flagged" });
    expect(calls).toHaveLength(0);
  });

  it("an event signed with the key the workspace replaced → the stale-key path flags it", async () => {
    seedSub(SA, OTHER_KEY);
    const res = await deliver({ key: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "stale_key" });
    expect(order()).toMatchObject({ status: "pending", attentionOpen: true });
    expect(order().attention).toMatch(/Paystack key was changed/);
    expect(attempt()).toMatchObject({ state: "flagged" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a reference with no attempt is never paid", async () => {
    mem.clear();
    seedSub();
    seedOrder();
    expect((await deliver()).status).toBe(200);
    expect(order()).toMatchObject({ status: "pending" });
    expect(calls).toHaveLength(0);
  });

  it("an attempt that belongs to another tenant is never paid, even for this tenant's order", async () => {
    seedOrderAttempt({ subAccountId: OTHER_SA });
    await deliver();
    expect(order()).toMatchObject({ status: "pending" });
    expect(calls).toHaveLength(0);
  });

  it("an attempt that names another order is never paid", async () => {
    seedOrderAttempt({ orderId: "ord2" });
    await deliver();
    expect(order()).toMatchObject({ status: "pending" });
    expect(calls).toHaveLength(0);
  });

  it("another tenant's order is never paid through this tenant's webhook", async () => {
    seedSub(OTHER_SA, KEY);
    seedOrder({ subAccountId: OTHER_SA });
    await deliver();
    expect(order()).toMatchObject({ status: "pending" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a verify answer that is not a success for this reference pays nothing", async () => {
    verifyAnswer = () => verified({ reference: REF, status: "abandoned" });
    await deliver();
    verifyAnswer = () => verified({ reference: "po-other" });
    await deliver();
    expect(order()).toMatchObject({ status: "pending" });
    expect(attempt()).toMatchObject({ state: "open" });
  });

  it("Paystack unreachable → 503 so it redelivers; the redelivery pays", async () => {
    verifyAnswer = () => "network-error";
    expect((await deliver()).status).toBe(503);
    expect(order()).toMatchObject({ status: "pending" });
    verifyAnswer = () => verified({ reference: REF, amount: 49_900 });
    expect((await deliver()).status).toBe(200);
    expect(order()).toMatchObject({ status: "paid" });
  });

  it("Paystack says the reference is unknown → final 200, nothing paid", async () => {
    verifyAnswer = () => refused(404, "Transaction reference not found");
    expect((await deliver()).status).toBe(200);
    expect(order()).toMatchObject({ status: "pending" });
  });
});

describe("money for an order that can no longer be paid is flagged, not dropped", () => {
  it("a failed order: not paid, not delivered, flagged for a refund", async () => {
    seedOrder({ status: "failed" });
    await deliver();
    await flushAfterResponse();
    expect(order()).toMatchObject({ status: "failed", attentionOpen: true });
    expect(order().attention).toMatch(/already failed/);
    expect(attempt()).toMatchObject({ state: "flagged" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(paidEvents()).toHaveLength(0);
  });

  it("an order already paid is not flagged by a late stale-key event", async () => {
    await deliver();
    await flushAfterResponse();
    seedSub(SA, OTHER_KEY);
    await deliver({ key: KEY });
    expect(order().attention ?? null).toBeNull();
    expect(order()).toMatchObject({ status: "paid" });
  });
});
