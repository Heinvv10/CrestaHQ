import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

import {
  deliverTo,
  failFirst,
  mem,
  seedConnection,
  seedInvoice,
  seedOrder,
  SA,
  session,
} from "@/test/stripe-orders-harness";

/**
 * Seam tests: signed Stripe event → real route → real reconciler → real
 * orders / quotes / bookings services, over an in-memory Firestore. Only the
 * outbound side effects (workflows, webhooks, email, Google push) are stubbed.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/stripe-orders-harness")).adminMock());
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

// Confirming a booking rotates its public token, which is HMAC-signed.
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-32-characters-long";
const deliver = deliverTo((await import("./route")).POST);

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  seedConnection();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

afterEach(() => vi.restoreAllMocks());

it("a transient failure marking the invoice paid answers 5xx, and Stripe's retry finishes the job once", async () => {
  seedInvoice();
  seedOrder("o1");
  const restore = failFirst("quotes", "get");
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBeGreaterThanOrEqual(500);
  restore();
  expect(mem.read("orders/o1")).toMatchObject({ status: "paid" });
  expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });

  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
  await flushAfterResponse();
  expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);

  // A further replay is a quiet no-op: no flag, no second trigger.
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  expect(mem.read("orders/o1")!.attention ?? null).toBeNull();
  await flushAfterResponse();
  expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
});

it("a transient failure confirming a booking deposit answers 5xx; the retry confirms it", async () => {
  mem.seed("events/ev1", { subAccountId: SA, agencyId: "ag1", status: "awaiting_payment", contactId: null });
  seedOrder("o1", { source: "booking_deposit", quoteId: null, eventId: "ev1" });
  // Mark-paid is a transaction, so the failure is injected at its read.
  const restore = failFirst("events", "get");
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBeGreaterThanOrEqual(500);
  expect(mem.read("events/ev1")).toMatchObject({ status: "awaiting_payment" });
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  restore();
  expect(mem.read("events/ev1")).toMatchObject({ status: "scheduled", paidOrderId: "o1" });
  // A further replay finds the booking confirmed by this same order: no flag.
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  expect(mem.read("orders/o1")!.attention ?? null).toBeNull();
});

it("ignored event types and unpaid sessions still answer 200", async () => {
  expect((await deliver("customer.created", { id: "cus_1" })).status).toBe(200);
  seedOrder("o1");
  seedInvoice();
  expect((await deliver("checkout.session.completed", session("cs_o1", { payment_status: "unpaid" }))).status).toBe(200);
  expect(mem.read("orders/o1")).toMatchObject({ status: "pending" });
});

it("an invoice raised after the session opened is not marked paid for the old amount — the order is flagged", async () => {
  seedOrder("o1"); // opened for R1,150.00
  seedInvoice({ lineItems: [{ id: "li1", description: "Install", quantity: 2, unitPrice: 1000 }] });
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  expect(mem.read("orders/o1")).toMatchObject({ status: "paid" });
  expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });
  expect(mem.read("orders/o1")!.attention).toMatch(/changed after checkout/i);
  await flushAfterResponse();
  expect(effects.fireQuoteTrigger).not.toHaveBeenCalled();
});

it("a session that collected a different amount than its order is flagged, not marked paid", async () => {
  seedOrder("o1");
  seedInvoice();
  expect((await deliver("checkout.session.completed", session("cs_o1", { amount_total: 5000 }))).status).toBe(200);
  expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });
  expect(mem.read("orders/o1")!.attention).toBeTruthy();
});

it("a second payment for an already-paid invoice is flagged on its order; the first payer's replay is not", async () => {
  seedInvoice();
  seedOrder("o1");
  seedOrder("o2");
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  expect((await deliver("checkout.session.completed", session("cs_o2"), "evt_2")).status).toBe(200);
  expect(mem.read("orders/o2")).toMatchObject({ status: "paid" });
  expect(mem.read("orders/o2")!.attention).toMatch(/already paid/i);
  expect(mem.read("orders/o1")!.attention ?? null).toBeNull();
  await flushAfterResponse();
  expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
});

it("a second deposit for an already-confirmed booking is flagged on its order", async () => {
  mem.seed("events/ev1", { subAccountId: SA, agencyId: "ag1", status: "awaiting_payment", contactId: null });
  seedOrder("o1", { source: "booking_deposit", quoteId: null, eventId: "ev1" });
  seedOrder("o2", { source: "booking_deposit", quoteId: null, eventId: "ev1" });
  await deliver("checkout.session.completed", session("cs_o1"));
  await deliver("checkout.session.completed", session("cs_o2"), "evt_2");
  expect(mem.read("orders/o2")!.attention).toMatch(/booking/i);
  expect(mem.read("orders/o1")!.attention ?? null).toBeNull();
});

it("checkout.session.async_payment_succeeded marks a delayed-payment order paid", async () => {
  seedInvoice();
  seedOrder("o1");
  expect((await deliver("checkout.session.async_payment_succeeded", session("cs_o1"))).status).toBe(200);
  expect(mem.read("orders/o1")).toMatchObject({ status: "paid" });
  expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
});

it("a zero-decimal (JPY) session is matched and fully refunded in Stripe's whole-yen amounts", async () => {
  seedInvoice({ currency: "JPY" }); // ¥1,150
  seedOrder("o1", { currency: "jpy" });
  const jpy = session("cs_o1", { amount_total: 1150, currency: "jpy" });
  expect((await deliver("checkout.session.completed", jpy)).status).toBe(200);
  expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
  expect(mem.read("orders/o1")!.attention ?? null).toBeNull();

  const charge = { id: "ch_1", object: "charge", payment_intent: "pi_cs_o1", amount_refunded: 1150 };
  expect((await deliver("charge.refunded", charge, "evt_r")).status).toBe(200);
  expect(mem.read("orders/o1")).toMatchObject({ status: "refunded", refundedCents: 115000 });
});
