import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KEY,
  LIVE_KEY,
  mem,
  seedAttempt,
  seedInvoice,
  seedLink,
  seedSub,
  stubPaystack,
  type PaystackCall,
} from "@/test/paystack-links-harness";

/**
 * The public pay page: real route → real service → in-memory Firestore, with
 * Paystack's HTTP API stubbed. What must hold: the amount sent to Paystack is
 * the doc's whatever the request says, the tenant's own key is used, and
 * nothing a payer does here — including returning from checkout — marks the
 * link paid.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-16";
process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.com";

const { GET, POST } = await import("./route");
const { issuePaymentLinkToken } = await import("@/lib/billing/token");

let calls: PaystackCall[];
let token: string;
let ip = 0;

function get(query = "") {
  return GET(new Request(`https://crm.example.com/pay/link/${token}${query}`), {
    params: Promise.resolve({ token }),
  });
}

function post(fields: Record<string, string>, t = token) {
  return POST(
    new Request(`https://crm.example.com/pay/link/${t}`, {
      method: "POST",
      // A fresh IP per call so the per-IP rate limit never decides a test.
      headers: { "x-forwarded-for": `10.0.0.${++ip}` },
      body: new URLSearchParams(fields),
    }),
    { params: Promise.resolve({ token: t }) },
  );
}

beforeEach(() => {
  mem.clear();
  seedSub();
  token = issuePaymentLinkToken("link1");
  seedLink("link1", { token });
  calls = stubPaystack(() => ({
    body: { status: true, data: { authorization_url: "https://checkout.paystack.com/abc", reference: "r" } },
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("starting a checkout", () => {
  it("charges the doc's amount with the tenant's key, even when the request names another amount", async () => {
    const res = await post({ email: "payer@example.com", amount: "1", amountCents: "1", currency: "NGN" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://checkout.paystack.com/abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/transaction/initialize", auth: `Bearer ${KEY}` });
    expect(calls[0].body).toMatchObject({
      email: "payer@example.com",
      amount: 45000,
      currency: "ZAR",
      callback_url: `https://crm.example.com/pay/link/${token}`,
    });
    expect(calls[0].body!.reference).toMatch(/^pl-link1-[0-9a-f]{16}$/);
  });

  it("uses a fresh reference per checkout, since Paystack refuses a repeated one", async () => {
    await post({ email: "payer@example.com" });
    await post({ email: "payer@example.com" });
    expect(calls[0].body!.reference).not.toBe(calls[1].body!.reference);
  });

  it("refuses a token with a bad signature without calling Paystack", async () => {
    const forged = token.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    expect((await post({ email: "payer@example.com" }, forged)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("refuses a validly signed token the doc no longer carries", async () => {
    const stale = issuePaymentLinkToken("link1");
    expect((await post({ email: "payer@example.com" }, stale)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("refuses a deactivated link", async () => {
    seedLink("link1", { token, active: false });
    expect((await post({ email: "payer@example.com" })).status).toBe(410);
    expect(calls).toEqual([]);
  });

  it("refuses a link that is already paid", async () => {
    seedLink("link1", { token, status: "paid" });
    expect((await post({ email: "payer@example.com" })).status).toBe(410);
    expect(calls).toEqual([]);
  });

  it("refuses an invoice link whose invoice total changed since it was made", async () => {
    seedInvoice("inv1", { globalTaxPercent: null }); // R1,000 now, link says R1,150
    seedLink("link1", { token, invoiceId: "inv1", amountCents: 115000 });
    expect((await post({ email: "payer@example.com" })).status).toBe(410);
    expect(calls).toEqual([]);
  });

  it("charges an invoice link whose invoice still matches", async () => {
    seedInvoice("inv1");
    seedLink("link1", { token, invoiceId: "inv1", amountCents: 115000 });
    expect((await post({ email: "payer@example.com" })).status).toBe(303);
    expect(calls[0].body).toMatchObject({ amount: 115000 });
  });

  it("refuses checkout once the agency has switched Payments off", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", paymentsEnabledByAgency: false });
    expect((await post({ email: "payer@example.com" })).status).toBe(409);
    expect((await get()).status).toBe(409);
    expect(calls).toEqual([]);
  });

  it("refuses an invoice link whose invoice has expired", async () => {
    seedInvoice("inv1", { validUntil: { seconds: Math.floor(Date.now() / 1000) - 86_400 } });
    seedLink("link1", { token, invoiceId: "inv1", amountCents: 115000 });
    const res = await post({ email: "payer@example.com" });
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("expired");
    expect(calls).toEqual([]);
  });

  it("refuses checkout when the link is withdrawn after the page check but before the attempt", async () => {
    const db = mem.db as { runTransaction: typeof mem.db.runTransaction };
    const real = db.runTransaction;
    db.runTransaction = (fn) => {
      db.runTransaction = real;
      seedLink("link1", { token, active: false }); // the operator's withdraw lands here
      return real(fn);
    };
    try {
      expect((await post({ email: "payer@example.com" })).status).toBe(410);
    } finally {
      db.runTransaction = real;
    }
    expect(calls).toEqual([]);
    expect(mem.list("paymentAttempts")).toEqual([]);
  });

  it("refuses a missing email", async () => {
    expect((await post({})).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("the payer returning from Paystack", () => {
  it("never marks the link paid, whatever the callback query says", async () => {
    const res = await get("?trxref=pl-link1-0123456789abcdef&reference=pl-link1-0123456789abcdef&status=success");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Confirming your payment");
    expect(mem.read("paymentLinks/link1")).toMatchObject({ status: "open", paystackReference: null });
    expect(calls).toEqual([]);
  });

  it("shows a paid confirmation, not a dead link, when the webhook recorded this reference first", async () => {
    const ref = "pl-link1-0123456789abcdef";
    seedInvoice("inv1", { status: "paid" });
    seedLink("link1", { token, invoiceId: "inv1", amountCents: 115000, status: "paid", paystackReference: ref });
    const res = await get(`?trxref=${ref}&reference=${ref}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Payment received");
    expect(html).not.toContain("can't be used");
  });

  it("re-checks a confirming page, keeping the reference, so a late webhook still shows the payer it landed", async () => {
    const res = await get("?trxref=pl-link1-0123456789abcdef&reference=pl-link1-0123456789abcdef");
    expect(await res.text()).toContain(
      '<meta http-equiv="refresh" content="3;url=?trxref=pl-link1-0123456789abcdef&#38;reference=pl-link1-0123456789abcdef&#38;recheck=1">',
    );
  });

  it("stops re-checking once the confirming page has reloaded its limit", async () => {
    const res = await get("?reference=pl-link1-0123456789abcdef&recheck=20");
    const html = await res.text();
    expect(html).toContain("Confirming your payment");
    expect(html).not.toContain("http-equiv");
  });

  it("does not re-check a page that already says the payment was received", async () => {
    const ref = "pl-link1-0123456789abcdef";
    seedLink("link1", { token, status: "paid", paystackReference: ref });
    const html = await (await get(`?reference=${ref}`)).text();
    expect(html).toContain("Payment received");
    expect(html).not.toContain("http-equiv");
  });

  it("says confirming, not paid, when the link was paid under a different reference", async () => {
    seedLink("link1", { token, status: "paid", paystackReference: "pl-link1-ffffffffffffffff" });
    const res = await get("?reference=pl-link1-0123456789abcdef");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Confirming your payment");
    expect(html).not.toContain("Payment received");
  });

  it("tells a returning payer their payment is being confirmed even once the invoice changed", async () => {
    seedInvoice("inv1", { status: "paid" }); // e.g. paid by this very checkout
    seedLink("link1", { token, invoiceId: "inv1", amountCents: 115000 });
    const res = await get("?reference=pl-link1-0123456789abcdef");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Confirming your payment");
  });

  it("keeps refusing a withdrawn link, whatever reference the query names", async () => {
    seedLink("link1", { token, active: false });
    const res = await get("?reference=junk");
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).not.toContain("Call-out fee");
    expect(html).not.toMatch(/450/);
  });

  it("tells a payer whose checkout was on a since-withdrawn link that it is being confirmed", async () => {
    const ref = "pl-link1-0123456789abcdef";
    seedAttempt(ref);
    seedLink("link1", { token, active: false });
    const res = await get(`?reference=${ref}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Confirming your payment");
  });

  it("does not honour another link's checkout reference on a withdrawn link", async () => {
    const ref = "pl-link2-0123456789abcdef";
    seedAttempt(ref);
    seedLink("link1", { token, active: false });
    expect((await get(`?reference=${ref}`)).status).toBe(410);
  });

  it("tells a payer whose checkout predates Payments being switched off that it is being confirmed", async () => {
    const ref = "pl-link1-0123456789abcdef";
    seedAttempt(ref);
    mem.seed("subAccounts/sa1", { agencyId: "ag1", paymentsEnabledByAgency: false });
    const res = await get(`?reference=${ref}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Confirming your payment");
  });

  it("keeps refusing a link once Payments is off, whatever reference the query names", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", paymentsEnabledByAgency: false });
    const res = await get("?reference=junk");
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain("Call-out fee");
  });

  it("labels the page TEST MODE while the connection is in test mode", async () => {
    expect(await (await get()).text()).toContain("TEST MODE");
  });

  it("shows no banner on a live link and charges it with the live key", async () => {
    seedSub("sa1", LIVE_KEY);
    seedLink("link1", { token, mode: "live" });
    expect(await (await get()).text()).not.toContain("TEST MODE");
    expect((await post({ email: "payer@example.com" })).status).toBe(303);
    expect(calls[0]).toMatchObject({ path: "/transaction/initialize", auth: `Bearer ${LIVE_KEY}` });
  });

  it("retires a test link once the connection goes live: no page, no checkout", async () => {
    // Round-4 breaker repro: link made under a test key, then the operator
    // connected the live key. The page must never say "no real money" over
    // a live charge — now it offers no checkout at all.
    seedSub("sa1", LIVE_KEY);
    const page = await get();
    expect(page.status).toBe(410);
    expect(await page.text()).not.toContain("TEST MODE");
    expect((await post({ email: "payer@example.com" })).status).toBe(410);
    expect(calls).toEqual([]);
  });

  it("retires a link made before links carried a mode", async () => {
    seedLink("link1", { token, mode: undefined });
    expect((await get()).status).toBe(410);
    expect((await post({ email: "payer@example.com" })).status).toBe(410);
    expect(calls).toEqual([]);
  });

  it("shows the amount from the doc on the pay page", async () => {
    const html = await (await get()).text();
    expect(html).toContain("Call-out fee");
    expect(html).toMatch(/450/);
  });
});
