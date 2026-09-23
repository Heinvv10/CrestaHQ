import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { LIVE_KEY, SA, mem, seedInvoice, seedLink, seedSub, stubPaystack, verified } from "@/test/paystack-links-harness";

/**
 * Ported from the round-4 breaker repro. A link made while the connection was
 * in test mode, then the operator connects the LIVE key. Before, the page said
 * "no real money" while checkout took real money. Now a link is paid only in
 * the mode it was issued in: the test link is retired, and a fresh link made
 * under the live key is labelled, charged and recorded as live end to end.
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

it("a link made in test mode is retired once the key goes live; a fresh live link is charged and recorded as live", async () => {
  seedSub(SA, LIVE_KEY); // the connection is live NOW
  seedInvoice();
  const oldToken = issuePaymentLinkToken("link1");
  seedLink("link1", { token: oldToken, invoiceId: "inv1", amountCents: 115000, mode: "test" });

  let ref = "";
  const calls = stubPaystack((c) => {
    if (c.method === "POST") {
      ref = String(c.body!.reference);
      return { body: { status: true, data: { authorization_url: "https://checkout.paystack.com/x", reference: ref } } };
    }
    return verified({ reference: ref, amount: 115000, domain: "live" });
  });
  const post = (token: string) =>
    POST(
      new Request(`https://crm.example.com/pay/link/${token}`, {
        method: "POST",
        headers: { "x-forwarded-for": "10.9.9.9" },
        body: new URLSearchParams({ email: "a@b.co" }),
      }),
      { params: Promise.resolve({ token }) },
    );

  const oldPage = await GET(new Request(`https://crm.example.com/pay/link/${oldToken}`), { params: Promise.resolve({ token: oldToken }) });
  expect(oldPage.status).toBe(410);
  expect(await oldPage.text()).not.toContain("TEST MODE");
  expect((await post(oldToken)).status).toBe(410);
  expect(calls).toEqual([]);

  const token = issuePaymentLinkToken("link2");
  seedLink("link2", { token, invoiceId: "inv1", amountCents: 115000, mode: "live" });
  const page = await (await GET(new Request(`https://crm.example.com/pay/link/${token}`), { params: Promise.resolve({ token }) })).text();
  expect(page).not.toContain("TEST MODE");
  expect((await post(token)).status).toBe(303);
  expect(calls[0]).toMatchObject({ method: "POST", path: "/transaction/initialize", auth: `Bearer ${LIVE_KEY}` });
  expect(mem.read(`paymentAttempts/${ref}`)).toMatchObject({ mode: "live", state: "open", paymentLinkId: "link2" });

  const body = JSON.stringify({ event: "charge.success", data: { reference: ref } });
  const sig = createHmac("sha512", LIVE_KEY).update(body).digest("hex");
  const wh = await WEBHOOK(
    new Request(`http://x/api/webhooks/paystack/sa/${SA}`, { method: "POST", headers: { "x-paystack-signature": sig }, body }),
    { params: Promise.resolve({ subAccountId: SA }) },
  );
  expect(wh.status).toBe(200);
  expect(mem.read("paymentLinks/link2")).toMatchObject({ status: "paid", paystackDomain: "live" });
  expect(mem.read("paymentLinks/link2")!.attention ?? null).toBeNull();
  expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
});
