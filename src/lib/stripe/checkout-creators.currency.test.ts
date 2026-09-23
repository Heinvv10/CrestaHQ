import { beforeEach, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Every checkout creator hands Stripe the currency's own minor unit — the
 * checkout-page and community routes as well as invoices and deposits — and
 * refuses a currency it cannot price.
 */

const mem = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createMemoryFirestore> }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db.db }));
vi.mock("@/lib/checkout/rate-limit", () => ({ checkCheckoutRateLimit: () => ({ ok: true }), clientIpFrom: () => "ip" }));
vi.mock("@/lib/comms/ai/capture", () => ({ reconcileContactFromCapture: vi.fn(async () => null) }));
vi.mock("@/lib/community/member-context", () => ({
  requireMemberApi: async () => ({ kind: "ok", member: { id: "m1" } }),
}));
const stripe = vi.hoisted(() => ({
  createCheckoutSessionForSubAccount: vi.fn(async (_: unknown) => ({ id: "cs_1", url: "https://stripe.test/cs_1", livemode: false })),
  getSubAccountStripe: vi.fn(async () => ({})),
  StripeConnectionError: class extends Error {},
}));
vi.mock("@/lib/stripe/sub-account-client", () => stripe);

mem.db = createMemoryFirestore();
const { POST: CHECKOUT_PAGE } = await import("@/app/api/co/[subAccountId]/[slug]/session/route");
const { POST: COMMUNITY } = await import("@/app/api/community/[saId]/[groupId]/purchase/[purchaseId]/pay/route");

const unitAmount = () =>
  (stripe.createCheckoutSessionForSubAccount.mock.calls[0][0] as {
    params: { line_items: { price_data: { unit_amount: number } }[] };
  }).params.line_items[0].price_data.unit_amount;

function seedProduct(currency: string) {
  mem.db.seed("subAccounts/sa1", { agencyId: "ag1", paymentsEnabledByAgency: true });
  mem.db.seed("subAccounts/sa1/checkoutPages/pg1", {
    slug: "offer",
    status: "published",
    productId: "p1",
    bumpProductIds: [],
    autoTags: [],
    pipelineStageId: null,
  });
  mem.db.seed("products/p1", {
    subAccountId: "sa1",
    active: true,
    name: "Course",
    description: "",
    unitPriceCents: 500000, // 5,000.00
    currency,
  });
}
const buyPage = () =>
  CHECKOUT_PAGE(new Request("http://x", { method: "POST", body: "{}" }), {
    params: Promise.resolve({ subAccountId: "sa1", slug: "offer" }),
  });

function seedPurchase(currency: string) {
  mem.db.seed("subAccounts/sa1", { agencyId: "ag1", paymentsEnabledByAgency: true });
  mem.db.seed("subAccounts/sa1/communityGroups/g1/purchases/pu1", {
    agencyId: "ag1",
    memberId: "m1",
    status: "pending",
    scope: "group",
    targetId: "g1",
    amountCents: 300000, // 3,000.00
    currency,
  });
}
const payPurchase = () =>
  COMMUNITY(new Request("http://x", { method: "POST" }), {
    params: Promise.resolve({ saId: "sa1", groupId: "g1", purchaseId: "pu1" }),
  });

beforeEach(() => {
  mem.db.clear();
  vi.clearAllMocks();
});

it("checkout page: JPY in whole yen, USD in cents", async () => {
  seedProduct("JPY");
  expect((await buyPage()).status).toBe(200);
  expect(unitAmount()).toBe(5000);
  vi.clearAllMocks();
  mem.db.clear();
  seedProduct("USD");
  expect((await buyPage()).status).toBe(200);
  expect(unitAmount()).toBe(500000);
});

it("community purchase: JPY in whole yen, USD in cents", async () => {
  seedPurchase("JPY");
  expect((await payPurchase()).status).toBe(200);
  expect(unitAmount()).toBe(3000);
  vi.clearAllMocks();
  mem.db.clear();
  seedPurchase("USD");
  expect((await payPurchase()).status).toBe(200);
  expect(unitAmount()).toBe(300000);
});

it("a three-decimal currency is refused before any session opens", async () => {
  seedProduct("KWD");
  expect((await buyPage()).status).toBe(409);
  mem.db.clear();
  seedPurchase("KWD");
  expect((await payPurchase()).status).toBe(409);
  expect(stripe.createCheckoutSessionForSubAccount).not.toHaveBeenCalled();
});
