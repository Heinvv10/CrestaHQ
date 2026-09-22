import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { LIVE_KEY, SA, mem, seedInvoice, seedLink, seedSub, stubPaystack, verified } from "@/test/paystack-links-harness";

/**
 * Ported from the round-4 breaker repro. A link made while the connection was
 * in test mode, then the operator connects the LIVE key. Before the fix the
 * page said "no real money", checkout took real money, and the reconciler
 * refused the live payment as a mode mismatch — money taken, never recorded.
 * Mode is now the connection's CURRENT mode, end to end.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/quotes/lifecycle", () => ({
  recordQuoteActivity: vi.fn(async () => {}),
  fireQuoteTrigger: vi.fn(async () => {}),
  emitQuoteWebhook: vi.fn(async () => {}),
}));
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: vi.fn(async () => {}) }));
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-16";
process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.com";

const { GET, POST } = await import("./route");
const { POST: WEBHOOK } = await import("@/app/api/webhooks/paystack/sa/[subAccountId]/route");
const { issuePaymentLinkToken } = await import("@/lib/billing/token");

beforeEach(() => {
  mem.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("a link made in test mode, paid after the key went live: no test banner, live checkout, recorded as paid", async () => {
  seedSub(SA, LIVE_KEY); // the connection is live NOW
  seedInvoice();
  const token = issuePaymentLinkToken("link1");
  seedLink("link1", { token, invoiceId: "inv1", amountCents: 115000 });

  let ref = "";
  const calls = stubPaystack((c) => {
    if (c.method === "POST") {
      ref = String(c.body!.reference);
      return { body: { status: true, data: { authorization_url: "https://checkout.paystack.com/x", reference: ref } } };
    }
    return verified({ reference: ref, amount: 115000, domain: "live" });
  });

  const page = await (await GET(new Request(`https://crm.example.com/pay/link/${token}`), { params: Promise.resolve({ token }) })).text();
  expect(page).not.toContain("TEST MODE");

  const res = await POST(
    new Request(`https://crm.example.com/pay/link/${token}`, {
      method: "POST",
      headers: { "x-forwarded-for": "10.9.9.9" },
      body: new URLSearchParams({ email: "a@b.co" }),
    }),
    { params: Promise.resolve({ token }) },
  );
  expect(res.status).toBe(303);
  expect(calls[0]).toMatchObject({ method: "POST", path: "/transaction/initialize", auth: `Bearer ${LIVE_KEY}` });

  const body = JSON.stringify({ event: "charge.success", data: { reference: ref } });
  const sig = createHmac("sha512", LIVE_KEY).update(body).digest("hex");
  const wh = await WEBHOOK(
    new Request(`http://x/api/webhooks/paystack/sa/${SA}`, { method: "POST", headers: { "x-paystack-signature": sig }, body }),
    { params: Promise.resolve({ subAccountId: SA }) },
  );
  expect(wh.status).toBe(200);
  expect(mem.read("paymentLinks/link1")).toMatchObject({ status: "paid", paystackDomain: "live" });
  expect(mem.read("paymentLinks/link1")!.attention ?? null).toBeNull();
  expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
});
