import Stripe from "stripe";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Seam tests: signed Stripe event → real route → real reconciler → real
 * orders / quotes / bookings services, over an in-memory Firestore. Only the
 * outbound side effects (workflows, webhooks, email, Google push) are stubbed.
 */

const mem = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createMemoryFirestore> }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db.db }));
const effects = vi.hoisted(() => ({
  recordQuoteActivity: vi.fn(async () => {}),
  fireQuoteTrigger: vi.fn(async () => {}),
  emitQuoteWebhook: vi.fn(async () => {}),
}));
vi.mock("@/lib/quotes/lifecycle", () => effects);
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: vi.fn(async () => {}) }));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => {}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: vi.fn(async () => {}) }));

mem.db = createMemoryFirestore();
// Confirming a booking rotates its public token, which is HMAC-signed.
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-32-characters-long";
const { POST } = await import("./route");

const SA = "sa1";
const SECRET = "whsec_test_1";

function deliver(type: string, object: Record<string, unknown>, id = "evt_1") {
  const payload = JSON.stringify({ id, object: "event", type, data: { object } });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return POST(
    new Request(`http://x/api/webhooks/stripe/sa/${SA}`, {
      method: "POST",
      headers: { "stripe-signature": header },
      body: payload,
    }),
    { params: Promise.resolve({ subAccountId: SA }) },
  );
}

const session = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  object: "checkout.session",
  payment_status: "paid",
  payment_intent: `pi_${id}`,
  amount_total: 115000,
  currency: "zar",
  customer_details: { email: "payer@example.com", name: "Payer" },
  ...over,
});

function seedOrder(id: string, over: Record<string, unknown> = {}) {
  mem.db.seed(`orders/${id}`, {
    agencyId: "ag1",
    subAccountId: SA,
    contactId: null,
    checkoutPageId: null,
    quoteId: "inv1",
    eventId: null,
    communityGroupId: null,
    purchaseId: null,
    source: "quote",
    status: "pending",
    currency: "zar",
    lineItems: [],
    subtotalCents: 115000,
    totalCents: 115000,
    refundedCents: 0,
    stripeCheckoutSessionId: `cs_${id}`,
    stripePaymentIntentId: null,
    livemode: false,
    buyerEmail: null,
    buyerName: null,
    ...over,
  });
}

/** R1,150.00 — 1000 + 15% tax. */
function seedInvoice(over: Record<string, unknown> = {}) {
  mem.db.seed("quotes/inv1", {
    agencyId: "ag1",
    subAccountId: SA,
    contactId: "c1",
    kind: "invoice",
    status: "sent",
    quoteNumber: "INV-1",
    currency: "ZAR",
    lineItems: [{ id: "li1", description: "Install", quantity: 1, unitPrice: 1000 }],
    globalDiscount: null,
    globalTaxPercent: 15,
    ...over,
  });
}

/** Make the first `get` of `path` reject, as a transient Firestore outage. */
function failFirstGet(path: string) {
  const realCollection = mem.db.db.collection;
  let failed = false;
  return vi.spyOn(mem.db.db, "collection").mockImplementation((name: string) => {
    const col = realCollection(name);
    return Object.assign(Object.create(col), {
      doc: (id?: string) => {
        const ref = col.doc(id);
        if (`${name}/${id}` !== path) return ref;
        return { ...ref, get: () => (failed ? ref.get() : ((failed = true), Promise.reject(new Error("14 UNAVAILABLE")))) };
      },
    });
  });
}

beforeEach(() => {
  mem.db.clear();
  vi.clearAllMocks();
  mem.db.seed(`subAccounts/${SA}/private/stripeConnection`, {
    mode: "key",
    restrictedKey: "rk_test_1",
    webhookSecret: SECRET,
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("a transient failure marking the invoice paid answers 5xx, and Stripe's retry finishes the job once", async () => {
  seedInvoice();
  seedOrder("o1");
  const spy = failFirstGet("quotes/inv1");
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBeGreaterThanOrEqual(500);
  spy.mockRestore();
  expect(mem.db.read("orders/o1")).toMatchObject({ status: "paid" });
  expect(mem.db.read("quotes/inv1")).toMatchObject({ status: "sent" });

  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  expect(mem.db.read("quotes/inv1")).toMatchObject({ status: "paid" });
  expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);

  // A further replay is a quiet no-op: no flag, no second trigger.
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  expect(mem.db.read("orders/o1")!.attention ?? null).toBeNull();
  expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
});

it("a transient failure confirming a booking deposit answers 5xx; the retry confirms it", async () => {
  mem.db.seed("events/ev1", { subAccountId: SA, agencyId: "ag1", status: "awaiting_payment", contactId: null });
  seedOrder("o1", { source: "booking_deposit", quoteId: null, eventId: "ev1" });
  const realCollection = mem.db.db.collection;
  let failed = false;
  const spy = vi.spyOn(mem.db.db, "collection").mockImplementation((name: string) => {
    const col = realCollection(name);
    if (name !== "events") return col;
    return Object.assign(Object.create(col), {
      doc: (id?: string) => {
        const ref = col.doc(id);
        return { ...ref, update: (p: Record<string, unknown>) => (failed ? ref.update(p) : ((failed = true), Promise.reject(new Error("14 UNAVAILABLE")))) };
      },
    });
  });
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBeGreaterThanOrEqual(500);
  expect(mem.db.read("events/ev1")).toMatchObject({ status: "awaiting_payment" });
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  spy.mockRestore();
  expect(mem.db.read("events/ev1")).toMatchObject({ status: "scheduled", paidOrderId: "o1" });
  // A further replay finds the booking confirmed by this same order: no flag.
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  expect(mem.db.read("orders/o1")!.attention ?? null).toBeNull();
});

it("ignored event types and unpaid sessions still answer 200", async () => {
  expect((await deliver("customer.created", { id: "cus_1" })).status).toBe(200);
  seedOrder("o1");
  seedInvoice();
  expect((await deliver("checkout.session.completed", session("cs_o1", { payment_status: "unpaid" }))).status).toBe(200);
  expect(mem.db.read("orders/o1")).toMatchObject({ status: "pending" });
});

it("an invoice raised after the session opened is not marked paid for the old amount — the order is flagged", async () => {
  seedOrder("o1"); // opened for R1,150.00
  seedInvoice({ lineItems: [{ id: "li1", description: "Install", quantity: 2, unitPrice: 1000 }] });
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  expect(mem.db.read("orders/o1")).toMatchObject({ status: "paid" });
  expect(mem.db.read("quotes/inv1")).toMatchObject({ status: "sent" });
  expect(mem.db.read("orders/o1")!.attention).toMatch(/changed after checkout/i);
  expect(effects.fireQuoteTrigger).not.toHaveBeenCalled();
});

it("a session that collected a different amount than its order is flagged, not marked paid", async () => {
  seedOrder("o1");
  seedInvoice();
  expect((await deliver("checkout.session.completed", session("cs_o1", { amount_total: 5000 }))).status).toBe(200);
  expect(mem.db.read("quotes/inv1")).toMatchObject({ status: "sent" });
  expect(mem.db.read("orders/o1")!.attention).toBeTruthy();
});

it("a second payment for an already-paid invoice is flagged on its order; the first payer's replay is not", async () => {
  seedInvoice();
  seedOrder("o1");
  seedOrder("o2");
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  expect((await deliver("checkout.session.completed", session("cs_o2"), "evt_2")).status).toBe(200);
  expect(mem.db.read("orders/o2")).toMatchObject({ status: "paid" });
  expect(mem.db.read("orders/o2")!.attention).toMatch(/already paid/i);
  expect(mem.db.read("orders/o1")!.attention ?? null).toBeNull();
  expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
});

it("a second deposit for an already-confirmed booking is flagged on its order", async () => {
  mem.db.seed("events/ev1", { subAccountId: SA, agencyId: "ag1", status: "awaiting_payment", contactId: null });
  seedOrder("o1", { source: "booking_deposit", quoteId: null, eventId: "ev1" });
  seedOrder("o2", { source: "booking_deposit", quoteId: null, eventId: "ev1" });
  await deliver("checkout.session.completed", session("cs_o1"));
  await deliver("checkout.session.completed", session("cs_o2"), "evt_2");
  expect(mem.db.read("orders/o2")!.attention).toMatch(/booking/i);
  expect(mem.db.read("orders/o1")!.attention ?? null).toBeNull();
});

it("checkout.session.async_payment_succeeded marks a delayed-payment order paid", async () => {
  seedInvoice();
  seedOrder("o1");
  expect((await deliver("checkout.session.async_payment_succeeded", session("cs_o1"))).status).toBe(200);
  expect(mem.db.read("orders/o1")).toMatchObject({ status: "paid" });
  expect(mem.db.read("quotes/inv1")).toMatchObject({ status: "paid" });
});

it("a zero-decimal (JPY) session is matched and fully refunded in Stripe's whole-yen amounts", async () => {
  seedInvoice({ currency: "JPY" }); // ¥1,150
  seedOrder("o1", { currency: "jpy" });
  const jpy = session("cs_o1", { amount_total: 1150, currency: "jpy" });
  expect((await deliver("checkout.session.completed", jpy)).status).toBe(200);
  expect(mem.db.read("quotes/inv1")).toMatchObject({ status: "paid" });
  expect(mem.db.read("orders/o1")!.attention ?? null).toBeNull();

  const charge = { id: "ch_1", object: "charge", payment_intent: "pi_cs_o1", amount_refunded: 1150 };
  expect((await deliver("charge.refunded", charge, "evt_r")).status).toBe(200);
  expect(mem.db.read("orders/o1")).toMatchObject({ status: "refunded", refundedCents: 115000 });
});
