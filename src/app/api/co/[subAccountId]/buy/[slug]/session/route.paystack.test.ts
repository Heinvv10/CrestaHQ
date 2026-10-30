import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KEY, SA, mem, stubPaystack, type PaystackCall } from "@/test/paystack-links-harness";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";

/**
 * Express buy session on the Paystack rail, through the real route, buy
 * service, pay-rail rule and orders service over an in-memory Firestore. Only
 * Paystack's HTTP API is stubbed. Covers: the order AND the payment attempt
 * committed BEFORE Paystack is called, the amount from the product doc (never
 * the body), the buyer's email required, a failed initialize closing both, and
 * the double-click dedupe.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());

const { POST } = await import("./route");

const SUB = {
  agencyId: "ag1",
  name: "Fixture",
  sellOnlineEnabledByAgency: true,
  paymentsEnabledByAgency: true,
  paystackConnectionMeta: { keyLast4: "45a2", currencies: ["ZAR"], livemode: false, webhookSeenAt: null, webhookUrl: null, connectedAt: new Date() },
};
const PRODUCT = {
  subAccountId: SA,
  agencyId: "ag1",
  createdByUid: "u1",
  name: "Fibre guide",
  description: "",
  unitPriceCents: 49_900,
  currency: "ZAR",
  active: true,
  sellOnline: true,
  slug: "fibre-guide",
};

let ip = 0;
const post = (body: Record<string, unknown> = { email: "Buyer@Example.com" }, slug = "fibre-guide") =>
  POST(
    new Request(`https://app.test/api/co/${SA}/buy/${slug}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.1.0.${++ip % 250}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ subAccountId: SA, slug }) },
  );
const orders = () => mem.list("orders");
const attempts = () => mem.list("paymentAttempts");
const REQ = "0b0e8c1e-5f4a-4c8e-9a1d-2f3b4c5d6e7f";

let calls: PaystackCall[];
let atInitialize: { orders: Record<string, unknown>[]; attempts: Record<string, unknown>[] } | null;
let initializeAnswer: () => { status?: number; body: unknown } | "network-error";

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "shop@example.com";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  mem.seed(`subAccounts/${SA}`, SUB);
  mem.seed(`subAccounts/${SA}/private/paystackConnection`, { secretKey: KEY });
  mem.seed("products/p1", PRODUCT);
  atInitialize = null;
  initializeAnswer = () => ({
    body: { status: true, data: { authorization_url: "https://checkout.paystack.com/abc", reference: "x" } },
  });
  calls = stubPaystack((call) => {
    atInitialize = { orders: orders().map((o) => ({ ...o })), attempts: attempts().map((a) => ({ ...a })) };
    return call.path === "/transaction/initialize" ? initializeAnswer() : { status: 404, body: {} };
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("happy path", () => {
  it("commits the order and the attempt before Paystack is called, then returns its URL", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.paystack.com/abc" });

    const [order] = orders();
    const reference = `po-${order.id}`;
    // Both records existed, linked, when Paystack was asked.
    expect(atInitialize!.orders[0]).toMatchObject({ status: "pending", paystackReference: reference });
    expect(atInitialize!.attempts).toEqual([
      expect.objectContaining({ id: reference, orderId: order.id, state: "open" }),
    ]);

    expect(order).toMatchObject({
      source: "product_link",
      status: "pending",
      productLinkProductId: "p1",
      currency: "zar",
      totalCents: 49_900,
      buyerEmail: "buyer@example.com",
      paystackReference: reference,
      stripeCheckoutSessionId: "",
      livemode: false,
    });
    expect(attempts()).toEqual([
      expect.objectContaining({
        id: reference,
        subAccountId: SA,
        orderId: order.id,
        paymentLinkId: "",
        amountCents: 49_900,
        currency: "ZAR",
        mode: "test",
        keyFingerprint: paystackKeyFingerprint(KEY),
        state: "open",
      }),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/transaction/initialize", auth: `Bearer ${KEY}` });
    expect(calls[0].body).toMatchObject({
      email: "buyer@example.com",
      amount: 49_900,
      currency: "ZAR",
      reference,
      metadata: expect.objectContaining({ orderId: order.id, productId: "p1" }),
    });
    const callback = new URL(String(calls[0].body!.callback_url));
    expect(callback.pathname).toBe(`/co/${SA}/buy/fibre-guide/thanks`);
    expect(callback.searchParams.get("order")).toBe(order.id);
    expect(callback.searchParams.get("t")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("the amount and currency come from the product doc, never the body", async () => {
    const res = await post({ email: "b@example.com", unitPriceCents: 1, amount: 1, currency: "usd" });
    expect(res.status).toBe(200);
    expect(calls[0].body).toMatchObject({ amount: 49_900, currency: "ZAR" });
    expect(orders()[0]).toMatchObject({ totalCents: 49_900, currency: "zar" });
    expect(attempts()[0]).toMatchObject({ amountCents: 49_900, currency: "ZAR" });
  });

  it("a live key opens a live-mode attempt and order", async () => {
    mem.seed(`subAccounts/${SA}/private/paystackConnection`, { secretKey: "sk_live_k3" });
    expect((await post()).status).toBe(200);
    expect(attempts()[0]).toMatchObject({ mode: "live", keyFingerprint: paystackKeyFingerprint("sk_live_k3") });
    expect(orders()[0]).toMatchObject({ livemode: true });
  });
});

describe("refusals: nothing written, Paystack never called", () => {
  const refused = (res: Response, status: number) => {
    expect(res.status).toBe(status);
    expect(orders()).toHaveLength(0);
    expect(attempts()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  };

  it.each([
    ["no email", {}],
    ["an empty email", { email: "  " }],
    ["not an email", { email: "nope" }],
    ["a non-string email", { email: ["a@b.co"] }],
    ["an over-long email", { email: `${"a".repeat(250)}@b.co` }],
    ["an address list", { email: "a@b.co,c@d.co" }],
    ["a semicolon list", { email: "a@b.co;c@d.co" }],
    ["a display name", { email: "Bob <a@b.co>" }],
    ["a quoted local part", { email: '"a b"@b.co' }],
    ["a comment", { email: "a(x)@b.co" }],
    ["inner whitespace", { email: "a b@b.co" }],
  ])("%s → 400", async (_name, body) => {
    refused(await post(body), 400);
  });

  it("gate off → 404", async () => {
    mem.seed(`subAccounts/${SA}`, { ...SUB, sellOnlineEnabledByAgency: false });
    refused(await post(), 404);
  });

  it("a non-ZAR product on a Paystack-only workspace → 404", async () => {
    mem.seed("products/p1", { ...PRODUCT, currency: "USD" });
    refused(await post(), 404);
  });

  it("a Paystack-only workspace whose connection is gone: the order is closed, Paystack not called", async () => {
    mem.seed(`subAccounts/${SA}/private/paystackConnection`, {});
    const res = await post();
    expect(res.status).toBe(503);
    expect(orders()).toHaveLength(1);
    expect(orders()[0]).toMatchObject({ status: "failed" });
    expect(attempts()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("a Paystack failure closes both records", () => {
  it("initialize refused → 502, attempt refused, order failed (never payable)", async () => {
    initializeAnswer = () => ({ status: 400, body: { status: false, message: "Invalid key" } });
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: expect.stringContaining("temporarily unavailable") });
    expect(orders()[0]).toMatchObject({ status: "failed" });
    expect(attempts()[0]).toMatchObject({ state: "refused" });
  });

  it("a network failure → the same, and the error text never carries Paystack's message", async () => {
    initializeAnswer = () => "network-error";
    const res = await post();
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toMatch(/fetch failed|Invalid key/);
    expect(orders()[0]).toMatchObject({ status: "failed" });
    expect(attempts()[0]).toMatchObject({ state: "refused" });
  });
});

describe("double-click dedupe", () => {
  it("the same request id and email reuses the checkout just opened", async () => {
    const a = await (await post({ email: "b@example.com", requestId: REQ })).json();
    const b = await (await post({ email: "b@example.com", requestId: REQ })).json();
    expect(b).toEqual(a);
    expect(orders()).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("the same request id with another email is another order (it is another buyer)", async () => {
    await post({ email: "b@example.com", requestId: REQ });
    await post({ email: "c@example.com", requestId: REQ });
    expect(orders().map((o) => o.buyerEmail).sort()).toEqual(["b@example.com", "c@example.com"]);
    expect(attempts()).toHaveLength(2);
  });
});
