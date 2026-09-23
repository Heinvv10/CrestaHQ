import Stripe from "stripe";
import { beforeEach, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Agency Stripe webhook → real Client Billing lifecycle, over an in-memory
 * Firestore. Delayed payment methods (SEPA, ACH, …) complete the session
 * unpaid and pay later; a charge link can be paid twice from two tabs.
 */

const mem = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createMemoryFirestore> }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db.db }));
const dispatch = vi.hoisted(() => ({ emitWebhookEvent: vi.fn(async (_: { type: string }) => {}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => dispatch);
vi.mock("@/lib/server/feature-gates-service", () => ({
  applyFeatureGates: vi.fn(async () => ({ skippedMetaGates: [] })),
}));

const SECRET = "whsec_agency_1";
process.env.STRIPE_SECRET_KEY = "sk_test_agency";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;

mem.db = createMemoryFirestore();
const { POST } = await import("./route");

function deliver(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: "evt_1", object: "event", type, data: { object } });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return POST(
    new Request("http://x/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": header },
      body: payload,
    }),
  );
}

const chargeSession = (id: string, payment_status = "paid") => ({
  id,
  object: "checkout.session",
  payment_status,
  payment_intent: `pi_${id}`,
  metadata: { kind: "subAccountCharge", agencyId: "ag1", subAccountId: "sa1", chargeId: "ch1" },
});
const planSession = (payment_status: string) => ({
  id: "cs_plan",
  object: "checkout.session",
  payment_status,
  customer: "cus_1",
  subscription: "sub_1",
  metadata: { kind: "subAccountPlan", subAccountId: "sa1", planId: "p1" },
});

beforeEach(() => {
  mem.db.clear();
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mem.db.seed("billingCharges/ch1", {
    agencyId: "ag1",
    subAccountId: "sa1",
    description: "Web design",
    amountCents: 50000,
    currency: "usd",
    status: "pending",
    tokenHash: "h",
    stripeCheckoutSessionId: "cs_b", // the last tab opened
    stripePaymentIntentId: null,
  });
  mem.db.seed("subAccounts/sa1", {
    agencyId: "ag1",
    billing: { status: "pending", planId: "p1", planName: "Pro", priceCents: 9900 },
  });
});

it("an unpaid (delayed-method) charge checkout is not marked paid until the payment settles", async () => {
  expect((await deliver("checkout.session.completed", chargeSession("cs_a", "unpaid"))).status).toBe(200);
  expect(mem.db.read("billingCharges/ch1")).toMatchObject({ status: "pending" });

  expect((await deliver("checkout.session.async_payment_succeeded", chargeSession("cs_a"))).status).toBe(200);
  expect(mem.db.read("billingCharges/ch1")).toMatchObject({ status: "paid", stripeCheckoutSessionId: "cs_a" });
});

it("an unpaid plan checkout does not activate the workspace; the settled payment does", async () => {
  await deliver("checkout.session.completed", planSession("unpaid"));
  expect(mem.db.read("subAccounts/sa1")!.billing).toMatchObject({ status: "pending" });

  await deliver("checkout.session.async_payment_succeeded", planSession("paid"));
  expect(mem.db.read("subAccounts/sa1")!.billing).toMatchObject({ status: "active" });
});

it("a trial / free plan checkout (no_payment_required) still activates", async () => {
  await deliver("checkout.session.completed", planSession("no_payment_required"));
  expect(mem.db.read("subAccounts/sa1")!.billing).toMatchObject({ status: "active" });
});

it("a second payment of an already-paid charge is recorded; a redelivery of the first is not", async () => {
  await deliver("checkout.session.completed", chargeSession("cs_a"));
  await deliver("checkout.session.completed", chargeSession("cs_a")); // redelivery
  expect(mem.db.read("billingCharges/ch1")!.extraPaymentRefs ?? []).toEqual([]);

  await deliver("checkout.session.completed", chargeSession("cs_b")); // the other tab
  await deliver("checkout.session.completed", chargeSession("cs_b")); // its redelivery
  expect(mem.db.read("billingCharges/ch1")).toMatchObject({
    status: "paid",
    stripeCheckoutSessionId: "cs_a",
    extraPaymentRefs: ["cs_b"],
  });
});

it("two payments racing for one charge: one marks it paid, the other is recorded, charge.paid fires once", async () => {
  await Promise.all([
    deliver("checkout.session.completed", chargeSession("cs_a")),
    deliver("checkout.session.completed", chargeSession("cs_b")),
  ]);
  const charge = mem.db.read("billingCharges/ch1")!;
  expect(charge.status).toBe("paid");
  expect(charge.extraPaymentRefs).toHaveLength(1);
  expect([charge.stripeCheckoutSessionId, ...(charge.extraPaymentRefs as string[])].sort()).toEqual(["cs_a", "cs_b"]);
  const paidEvents = dispatch.emitWebhookEvent.mock.calls.filter(([e]) => e.type === "billing.charge.paid");
  expect(paidEvents).toHaveLength(1);
});
