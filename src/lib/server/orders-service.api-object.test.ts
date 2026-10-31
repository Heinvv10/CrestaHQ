import { expect, it, vi } from "vitest";

import type { Order } from "@/types/orders";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => {}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const { serializeOrderForApi } = await import("./orders-service");

const ORDER = {
  id: "o1",
  status: "paid",
  currency: "usd",
  subtotalCents: 100,
  totalCents: 100,
  refundedCents: 0,
  lineItems: [],
  contactId: null,
  checkoutPageId: null,
  source: "checkout_page",
  livemode: true,
  buyerEmail: "b@example.com",
  buyerName: null,
  stripeCheckoutSessionId: "cs_1",
  stripePaymentIntentId: "pi_1",
} as unknown as Order;

it("a Stripe order's payload is unchanged: no paystack_reference key at all", () => {
  expect(serializeOrderForApi(ORDER)).not.toHaveProperty("paystack_reference");
});

it("a Paystack buy-page order adds its reference and keeps the empty Stripe session id", () => {
  const api = serializeOrderForApi({
    ...ORDER,
    source: "product_link",
    stripeCheckoutSessionId: "",
    stripePaymentIntentId: null,
    paystackReference: "po-o1",
  });
  expect(api).toMatchObject({ stripe_checkout_session_id: "", stripe_payment_intent_id: null, paystack_reference: "po-o1" });
});
