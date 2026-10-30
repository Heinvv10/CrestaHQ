import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Express buy session through the real route, buy service, pay-rail rule and
 * orders service over an in-memory Firestore. Only the Stripe API calls are
 * stubbed. Covers: the agency gate, the rail (Paystack is unit F3 → 503), the
 * amount from the product doc (never the body), the ambiguous-slug refusal,
 * the order written BEFORE the provider call, and the per-IP rate limit.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const stripe = vi.hoisted(() => ({
  getSubAccountStripe: vi.fn(async () => ({ mode: "key" })),
  createCheckoutSessionForSubAccount: vi.fn(),
}));
vi.mock("@/lib/stripe/sub-account-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/sub-account-client")>()),
  ...stripe,
}));

const { POST } = await import("./route");
const { StripeConnectionError } = await import("@/lib/stripe/sub-account-client");

const SA = "sa1";
const SUB = {
  agencyId: "ag1",
  name: "Fixture",
  sellOnlineEnabledByAgency: true,
  paymentsEnabledByAgency: true,
  communityEnabledByAgency: true,
  stripeConnectionMeta: { ready: true },
};
const PAYSTACK = { keyLast4: "45a2", currencies: ["ZAR"], livemode: false, webhookSeenAt: null, webhookUrl: null, connectedAt: new Date() };
const PRODUCT = {
  subAccountId: SA,
  agencyId: "ag1",
  name: "Fibre guide",
  description: "",
  unitPriceCents: 49_900,
  currency: "USD",
  active: true,
  sellOnline: true,
  slug: "fibre-guide",
};

let ip = 0;
const post = (body: unknown = {}, slug = "fibre-guide", sa = SA, addr = `10.0.0.${++ip % 250}`) =>
  POST(
    new Request(`https://app.test/api/co/${sa}/buy/${slug}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": addr },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ subAccountId: sa, slug }) },
  );
const orders = () => mem.list("orders");
type SessionArg = { subAccountId: string; params: Record<string, unknown> & { line_items: { price_data: { unit_amount: number; currency: string } }[]; metadata: Record<string, string>; success_url: string } };
const sessionArg = () => (stripe.createCheckoutSessionForSubAccount.mock.calls[0] as unknown as [SessionArg])[0];

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "shop@example.com";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  mem.seed(`subAccounts/${SA}`, SUB);
  mem.seed("products/p1", PRODUCT);
  stripe.createCheckoutSessionForSubAccount.mockImplementation(async () => ({
    id: "cs_test_1",
    url: "https://checkout.stripe.com/c/pay/cs_test_1",
    livemode: false,
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("happy path", () => {
  it("writes the order before Stripe is called, then attaches the session", async () => {
    let ordersAtCall: Record<string, unknown>[] = [];
    stripe.createCheckoutSessionForSubAccount.mockImplementationOnce(async () => {
      ordersAtCall = orders().map((o) => ({ ...o }));
      return { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", livemode: false };
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_1" });

    expect(ordersAtCall).toHaveLength(1);
    expect(ordersAtCall[0]).toMatchObject({ status: "pending", stripeCheckoutSessionId: "" });

    const [order] = orders();
    expect(order).toMatchObject({
      source: "product_link",
      status: "pending",
      productLinkProductId: "p1",
      currency: "usd",
      totalCents: 49_900,
      stripeCheckoutSessionId: "cs_test_1",
      contactId: null,
    });
    expect(order.thanksTokenHash).toMatch(/^[0-9a-f]{64}$/);

    const arg = sessionArg();
    expect(arg.params.metadata).toMatchObject({ leadstackOrderId: order.id, leadstackProductId: "p1" });
    const url = new URL(arg.params.success_url);
    expect(url.pathname).toBe(`/co/${SA}/buy/fibre-guide/thanks`);
    expect(url.searchParams.get("order")).toBe(order.id);
    expect(url.searchParams.get("t")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("the amount and currency come from the product doc, never the body", async () => {
    const res = await post({ unitPriceCents: 1, amount: 1, currency: "jpy", lineItems: [{ unitPriceCents: 1 }] });
    expect(res.status).toBe(200);
    expect(sessionArg().params.line_items).toEqual([
      expect.objectContaining({ quantity: 1, price_data: expect.objectContaining({ currency: "usd", unit_amount: 49_900 }) }),
    ]);
    expect(orders()[0]).toMatchObject({ totalCents: 49_900, currency: "usd" });
  });

  it("a linked checkout page that is no longer published is ignored: express sells", async () => {
    mem.seed("products/p1", { ...PRODUCT, checkoutPageId: "cp1" });
    mem.seed(`subAccounts/${SA}/checkoutPages/cp1`, { slug: "guide", productId: "p1", status: "draft" });
    expect((await post()).status).toBe(200);
  });
});

describe("refusals: nothing written, Stripe never called", () => {
  const refused = async (res: Response, status: number) => {
    expect(res.status).toBe(status);
    expect(orders()).toHaveLength(0);
    expect(stripe.createCheckoutSessionForSubAccount).not.toHaveBeenCalled();
  };

  it("gate off → 404", async () => {
    mem.seed(`subAccounts/${SA}`, { ...SUB, sellOnlineEnabledByAgency: false });
    await refused(await post(), 404);
  });

  it("Payments off → 404", async () => {
    mem.seed(`subAccounts/${SA}`, { ...SUB, paymentsEnabledByAgency: false });
    await refused(await post(), 404);
  });

  it("a Paystack-rail product (ZAR, Paystack only) → 503, no order, no session", async () => {
    mem.seed(`subAccounts/${SA}`, { ...SUB, stripeConnectionMeta: null, paystackConnectionMeta: PAYSTACK });
    mem.seed("products/p1", { ...PRODUCT, currency: "ZAR" });
    await refused(await post(), 503);
  });

  it("a non-ZAR product on a Paystack-only workspace → 404", async () => {
    mem.seed(`subAccounts/${SA}`, { ...SUB, stripeConnectionMeta: null, paystackConnectionMeta: PAYSTACK });
    await refused(await post(), 404);
  });

  it("two products sharing the slug → 404 (fails closed)", async () => {
    mem.seed("products/p2", { ...PRODUCT, name: "Other" });
    await refused(await post(), 404);
  });

  it("archived, off sale, re-priced to zero, or another tenant's → 404", async () => {
    for (const over of [{ active: false }, { sellOnline: false }, { unitPriceCents: 0 }, { currency: "XYZ" }, { subAccountId: "sa2" }]) {
      mem.seed("products/p1", { ...PRODUCT, ...over });
      await refused(await post(), 404);
    }
  });

  it("a malformed sub-account id or slug → 404 before any read", async () => {
    const doc = vi.spyOn(mem.db, "doc");
    const collection = vi.spyOn(mem.db, "collection");
    await refused(await post({}, "fibre-guide", "sa1/x"), 404);
    await refused(await post({}, "Fibre_Guide"), 404);
    expect(doc).not.toHaveBeenCalled();
    expect(collection).not.toHaveBeenCalled();
  });

  it("no email sending configured → 404", async () => {
    delete process.env.RESEND_API_KEY;
    await refused(await post(), 404);
  });

  it("a linked, published checkout page owns the sale → 409", async () => {
    mem.seed("products/p1", { ...PRODUCT, checkoutPageId: "cp1" });
    mem.seed(`subAccounts/${SA}/checkoutPages/cp1`, { slug: "guide", productId: "p1", status: "published" });
    await refused(await post(), 409);
  });

  it("community delivery: group deleted → 404; group present → 503 until F4 grants access", async () => {
    mem.seed("products/p1", { ...PRODUCT, delivery: { type: "community", communityGroupId: "g1", courseId: null } });
    await refused(await post(), 404);
    mem.seed(`subAccounts/${SA}/communityGroups/g1`, { name: "Members" });
    await refused(await post(), 503);
    mem.seed(`subAccounts/${SA}`, { ...SUB, communityEnabledByAgency: false });
    await refused(await post(), 404);
  });

  it("Stripe not usable → 503", async () => {
    stripe.getSubAccountStripe.mockRejectedValueOnce(new StripeConnectionError("not_ready", "webhook step not done"));
    await refused(await post(), 503);
  });
});

it("a failed Stripe session leaves the order failed, never payable", async () => {
  stripe.createCheckoutSessionForSubAccount.mockRejectedValueOnce(new Error("boom"));
  const res = await post();
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(orders()).toEqual([expect.objectContaining({ status: "failed", stripeCheckoutSessionId: "" })]);
});

it("the per-IP checkout rate limit applies", async () => {
  mem.seed(`subAccounts/${SA}`, { ...SUB, sellOnlineEnabledByAgency: false });
  const statuses: number[] = [];
  for (let i = 0; i < 16; i++) statuses.push((await post({}, "fibre-guide", SA, "203.0.113.9")).status);
  expect(statuses.slice(0, 15).every((s) => s === 404)).toBe(true);
  expect(statuses[15]).toBe(429);
});
