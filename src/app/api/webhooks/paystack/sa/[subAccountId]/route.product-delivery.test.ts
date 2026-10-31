import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

import {
  KEY,
  SA,
  mem,
  seedAttempt,
  seedSub,
  stubPaystack,
  verified,
} from "@/test/paystack-links-harness";

/**
 * Seam test: a Paystack `charge.success` for a community buy page order
 * through the REAL webhook route, reconciler and `finishPaidProductLinkOrder`
 * (the tail Stripe shares) into the REAL entitlements service. A paid order is
 * delivered exactly once, a held one never.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => {}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
const sendEmail = vi.hoisted(() =>
  vi.fn(async (_m: { to: string; subject: string; text: string }) => ({ id: "m1" })),
);
vi.mock("@/lib/comms/resend", async (orig) => ({
  ...(await orig<typeof import("@/lib/comms/resend")>()),
  sendEmail,
}));

const { POST } = await import("./route");

const REF = "po-ord1";

function deliver() {
  const body = JSON.stringify({ event: "charge.success", data: { reference: REF } });
  const signature = createHmac("sha512", KEY).update(body).digest("hex");
  return POST(
    new Request(`http://app.local/api/webhooks/paystack/sa/${SA}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paystack-signature": signature },
      body,
    }),
    { params: Promise.resolve({ subAccountId: SA }) },
  );
}

const entitlements = () => mem.list("entitlements");
const subjects = () => sendEmail.mock.calls.map(([m]) => m.subject);

let paidAmount: number;

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "shop@example.com";
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";
  seedSub();
  mem.seed(`subAccounts/${SA}`, {
    agencyId: "ag1",
    name: "Acme Fibre",
    paymentsEnabledByAgency: true,
    communityEnabledByAgency: true,
    paystackConnectionMeta: { webhookSeenAt: null, livemode: false },
  });
  mem.seed(`subAccounts/${SA}/communityGroups/g1`, {
    subAccountId: SA, agencyId: "ag1", name: "Fibre Club", slug: "fibre-club", access: "free", status: "published", memberCount: 0,
  });
  mem.seed("orders/ord1", {
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
    paystackReference: REF,
    livemode: false,
    buyerEmail: "buyer@example.com",
    buyerName: null,
    productLinkProductId: "p1",
    lineItems: [{ productId: "p1", name: "Fibre club", description: "", unitPriceCents: 49_900, quantity: 1, isBump: false }],
    deliveries: [{ productId: "p1", delivery: { type: "community", communityGroupId: "g1", courseId: null } }],
  });
  seedAttempt(REF, { paymentLinkId: "", orderId: "ord1", amountCents: 49_900 });
  paidAmount = 49_900;
  stubPaystack(() => verified({ reference: REF, amount: paidAmount }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Paystack payment → community delivery", () => {
  it("a paid order is confirmed, then granted: one entitlement, one membership, the sign-in mail", async () => {
    expect((await deliver()).status).toBe(200);
    await flushAfterResponse();

    expect(mem.read("orders/ord1")).toMatchObject({ status: "paid", deliveryStatus: { state: "done" } });
    expect(entitlements()).toEqual([
      expect.objectContaining({ id: "ord1_p1", orderId: "ord1", subAccountId: SA, agencyId: "ag1", status: "active" }),
    ]);
    expect(mem.list(`subAccounts/${SA}/communityGroups/g1/memberships`)).toHaveLength(1);
    // The confirmation lands first, the access mail after it.
    expect(subjects()).toEqual(["[Test] Order confirmed: Fibre club", "Your access to Fibre club"]);
  });

  it("replayed and overlapping confirmations grant once", async () => {
    const first = await Promise.all([deliver(), deliver(), deliver()]);
    // One may answer 503 while another holds the contact lease; Paystack redelivers.
    expect(first.every((r) => r.status === 200 || r.status === 503)).toBe(true);
    await flushAfterResponse();
    for (let i = 0; i < 2; i++) {
      expect((await deliver()).status).toBe(200);
      await flushAfterResponse();
    }

    expect(entitlements()).toHaveLength(1);
    expect(entitlements()[0].sends).toBe(1);
    expect(mem.list(`subAccounts/${SA}/communityGroups/g1/purchases`)).toHaveLength(1);
    expect(mem.read(`subAccounts/${SA}/communityGroups/g1`)!.memberCount).toBe(1);
    expect(subjects()).toEqual(["[Test] Order confirmed: Fibre club", "Your access to Fibre club"]);
  });

  it("a payment that does not match the order is held and delivers nothing", async () => {
    paidAmount = 100;
    expect((await deliver()).status).toBe(200);
    await flushAfterResponse();

    expect(mem.read("orders/ord1")).toMatchObject({ status: "pending" });
    expect(entitlements()).toHaveLength(0);
    expect(mem.list(`subAccounts/${SA}/members`)).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
