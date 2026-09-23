import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
 * Edge cases for the sub-account Stripe webhook seam (see route.reconcile.test.ts):
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

function seedCommunity() {
  mem.seed(`subAccounts/${SA}/communityGroups/g1`, { memberCount: 0 });
  mem.seed(`subAccounts/${SA}/communityGroups/g1/purchases/pu1`, {
    agencyId: "ag1",
    memberId: "m1",
    status: "pending",
    scope: "group",
    targetId: "g1",
    amountCents: 115000,
    currency: "ZAR",
  });
  seedOrder("o1", { source: "community", quoteId: null, communityGroupId: "g1", purchaseId: "pu1" });
}

it("a partial refund of a zero-decimal checkout-page order stays partial", async () => {
  seedOrder("o1", { source: "checkout_page", quoteId: null, currency: "jpy", totalCents: 500000 });
  await deliver("checkout.session.completed", session("cs_o1", { amount_total: 5000, currency: "jpy" }));
  const charge = { id: "ch_1", object: "charge", payment_intent: "pi_cs_o1", amount_refunded: 2000 };
  expect((await deliver("charge.refunded", charge, "evt_r")).status).toBe(200);
  expect(mem.read("orders/o1")).toMatchObject({ status: "partially_refunded", refundedCents: 200000 });
});

it("a pre-2025 Adaptive Pricing session is matched on its integration-currency amount", async () => {
  seedInvoice();
  seedOrder("o1");
  const converted = session("cs_o1", {
    amount_total: 6300,
    currency: "usd",
    currency_conversion: { amount_subtotal: 115000, amount_total: 115000, fx_rate: "0.0548", source_currency: "zar" },
  });
  expect((await deliver("checkout.session.completed", converted)).status).toBe(200);
  expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
  expect(mem.read("orders/o1")!.attention ?? null).toBeNull();
});

it("a transient failure settling a community purchase answers 5xx; the retry finishes it without double-counting", async () => {
  seedCommunity();
  // The purchase flip is the LAST write — fail it after access was granted.
  const restore = failFirst(`subAccounts/${SA}/communityGroups/g1/purchases`, "update");
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBeGreaterThanOrEqual(500);
  restore();
  expect(mem.read(`subAccounts/${SA}/communityGroups/g1/purchases/pu1`)).toMatchObject({ status: "pending" });
  expect(mem.read(`subAccounts/${SA}/communityGroups/g1`)).toMatchObject({ memberCount: 1 });
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  expect(mem.read(`subAccounts/${SA}/communityGroups/g1/purchases/pu1`)).toMatchObject({ status: "paid" });
  expect(mem.read(`subAccounts/${SA}/communityGroups/g1/memberships/m1`)).toMatchObject({ status: "active" });
  expect(mem.read(`subAccounts/${SA}/communityGroups/g1`)).toMatchObject({ memberCount: 1 });
});

it("a deleted community purchase is flagged with a 200, not retried", async () => {
  seedCommunity();
  mem.clear();
  seedConnection();
  seedOrder("o1", { source: "community", quoteId: null, communityGroupId: "g1", purchaseId: "pu1" });
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  expect(mem.read("orders/o1")!.attention).toMatch(/no longer exists/);
});

it("a redelivered event for an invoice paid before payers were recorded is not a second payment", async () => {
  seedInvoice({ status: "paid", paidVia: null });
  seedOrder("o1", { status: "paid" }); // this same payment, settled by the old code
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  expect(mem.read("orders/o1")!.attention ?? null).toBeNull();
});

it("a card payment for an invoice already marked paid by hand IS flagged", async () => {
  seedInvoice({ status: "paid", paidVia: null });
  seedOrder("o1");
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  expect(mem.read("orders/o1")!.attention).toMatch(/already paid/);
});

it("an order deleted before its flag is written answers 200 instead of looping", async () => {
  seedInvoice({ status: "paid", paidVia: null });
  seedOrder("o1");
  const restore = failFirst("orders", "update", Object.assign(new Error("5 NOT_FOUND"), { code: 5 }));
  // markOrderPaid writes in a transaction (tx.update), so the first plain
  // `update` on an order is the flag.
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  restore();
});
