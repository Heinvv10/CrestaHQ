import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

import {
  KEY,
  LIVE_KEY,
  OTHER_KEY,
  OTHER_SA,
  SA,
  mem,
  refused,
  seedAttempt,
  seedInvoice,
  seedLink,
  seedSub,
  stubPaystack,
  verified,
  type PaystackCall,
} from "@/test/paystack-links-harness";

/**
 * Seam test: the REAL webhook route → the REAL reconciler → the REAL
 * `markQuotePaidServerSide`, over an in-memory Firestore. Only Paystack's HTTP
 * API and the invoice's side-effect fan-out (activity, trigger, webhook,
 * review ask) are stubbed — the fan-out mocks are how "fired once" is
 * counted.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
const effects = vi.hoisted(() => ({
  recordQuoteActivity: vi.fn(async () => {}),
  fireQuoteTrigger: vi.fn(async () => {}),
  emitQuoteWebhook: vi.fn(async () => {}),
}));
vi.mock("@/lib/quotes/lifecycle", () => effects);
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: vi.fn(async () => {}) }));

const { POST } = await import("./route");

const REF = "pl-link1-0123456789abcdef";

function event(reference = REF, type = "charge.success") {
  return JSON.stringify({ event: type, data: { reference, amount: 45000, currency: "ZAR" } });
}

function deliver(opts: { body?: string; key?: string; sa?: string } = {}) {
  const body = opts.body ?? event();
  const signature = createHmac("sha512", opts.key ?? KEY).update(body).digest("hex");
  return POST(
    new Request(`http://app.local/api/webhooks/paystack/sa/${opts.sa ?? SA}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paystack-signature": signature },
      body,
    }),
    { params: Promise.resolve({ subAccountId: opts.sa ?? SA }) },
  );
}

const link = (id = "link1") => mem.read(`paymentLinks/${id}`)!;
let verifyAnswer: (call: PaystackCall) => ReturnType<typeof verified> | "network-error" | { status: number; body: unknown };
let calls: PaystackCall[];

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  seedSub();
  seedLink();
  seedAttempt(REF);
  verifyAnswer = () => verified({ reference: REF });
  calls = stubPaystack((c) => verifyAnswer(c));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("charge.success → payment link paid", () => {
  it("marks the link paid after re-verifying with THIS tenant's key", async () => {
    const res = await deliver();
    expect(res.status).toBe(200);
    expect(link()).toMatchObject({ status: "paid", paystackReference: REF, payerEmail: "payer@example.com" });
    expect(calls).toEqual([
      expect.objectContaining({ method: "GET", path: `/transaction/verify/${REF}`, auth: `Bearer ${KEY}` }),
    ]);
  });

  it("also marks the linked invoice paid, through the shared paid path", async () => {
    seedInvoice();
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    await deliver();
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
    await flushAfterResponse();
    expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on a replayed event: one paid transition, one invoice fan-out", async () => {
    seedInvoice();
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    await deliver();
    const version = (await mem.db.doc("paymentLinks/link1").get()).version;
    const res = await deliver();
    expect(res.status).toBe(200);
    // Not rewritten at all — not merely rewritten with the same values.
    expect((await mem.db.doc("paymentLinks/link1").get()).version).toBe(version);
    await flushAfterResponse();
    expect(effects.recordQuoteActivity).toHaveBeenCalledTimes(1);
    expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
  });

  it("H1: overlapping deliveries of one payment fire once and raise no refund flag", async () => {
    seedInvoice();
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    await Promise.all([deliver(), deliver(), deliver()]);
    expect(link().status).toBe("paid");
    expect(link().invoiceAttention ?? null).toBeNull();
    expect(link().invoiceSettledAt).toBeInstanceOf(Date);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid", paidVia: { rail: "paystack_link", linkId: "link1", reference: REF } });
    await flushAfterResponse();
    expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
    expect(effects.recordQuoteActivity).toHaveBeenCalledTimes(1);
  });

  it("does not touch an invoice already settled for this link on a replay", async () => {
    seedInvoice();
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000, status: "paid", paystackReference: REF, invoiceSettledAt: new Date() });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    await deliver();
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });
    await flushAfterResponse();
    expect(effects.fireQuoteTrigger).not.toHaveBeenCalled();
  });

  it("a pre-payment attention does not block the invoice retry (M)", async () => {
    seedInvoice();
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000, status: "paid", paystackReference: REF, attention: "stale" });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    await deliver();
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
    expect(link().invoiceSettledAt).toBeInstanceOf(Date);
  });

  it("the paid transition keeps the record of an earlier mismatched payment", async () => {
    verifyAnswer = () => verified({ reference: REF, amount: 100 });
    await deliver();
    expect(link().attention).toMatch(/does not match/i);
    verifyAnswer = () => verified({ reference: REF });
    await deliver();
    expect(link().status).toBe("paid");
    expect(link().attention).toMatch(/does not match/i);
  });

  it("a total edited between the check and the compare-and-set is flagged, not marked paid", async () => {
    seedInvoice();
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    // Ported from the round-4 breaker repro: raise the total right after the
    // reconciler's own read of the invoice, before its compare-and-set.
    const realDoc = mem.db.doc;
    const spy = vi.spyOn(mem.db, "doc").mockImplementation((path: string) => {
      const r = realDoc(path);
      return path === "quotes/inv1"
        ? {
            ...r,
            get: async () => {
              const snap = await r.get();
              mem.seed("quotes/inv1", {
                ...mem.read("quotes/inv1")!,
                lineItems: [{ id: "li1", description: "Install", quantity: 2, unitPrice: 1000 }],
              });
              return snap;
            },
          }
        : r;
    });
    expect((await deliver()).status).toBe(200);
    spy.mockRestore();
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });
    expect(link().invoiceAttention).toMatch(/changed/i);
    expect(link().invoiceSettledAt).toBeInstanceOf(Date);
    await flushAfterResponse();
    expect(effects.fireQuoteTrigger).not.toHaveBeenCalled();
  });

  it("H2: the settled write fails after the invoice committed; the redelivery raises no refund flag", async () => {
    seedInvoice();
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    const realDoc = mem.db.doc;
    let linkUpdates = 0;
    const spy = vi.spyOn(mem.db, "doc").mockImplementation((path: string) => {
      const r = realDoc(path);
      return path === "paymentLinks/link1"
        ? { ...r, update: (p: Record<string, unknown>) => (++linkUpdates === 1 ? Promise.reject(new Error("unavailable")) : r.update(p)) }
        : r;
    });
    expect((await deliver()).status).toBe(503);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
    expect(link().invoiceSettledAt ?? null).toBeNull();
    spy.mockRestore();
    expect((await deliver()).status).toBe(200);
    expect(link().invoiceAttention ?? null).toBeNull();
    expect(link().invoiceSettledAt).toBeInstanceOf(Date);
    await flushAfterResponse();
    expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
  });

  it("an invoice that cannot be read deterministically is settled with a flag, not retried forever", async () => {
    seedInvoice("inv1", { lineItems: null }); // malformed: totals throw
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    expect((await deliver()).status).toBe(200);
    expect(link()).toMatchObject({ status: "paid" });
    expect(link().invoiceAttention).toBeTruthy();
    expect(link().invoiceSettledAt).toBeInstanceOf(Date);
  });

  it("stamps invoiceSettledAt once the invoice is marked paid", async () => {
    seedInvoice();
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    await deliver();
    expect(link().invoiceSettledAt).toBeInstanceOf(Date);
  });

  it("finishes the invoice on redelivery after dying between the link commit and the invoice step", async () => {
    seedInvoice();
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    // First delivery: the invoice read and the attention write both fail —
    // a correlated Firestore outage right after the link committed paid.
    const realDoc = mem.db.doc;
    let quoteReads = 0;
    let linkUpdates = 0;
    const spy = vi.spyOn(mem.db, "doc").mockImplementation((path: string) => {
      const r = realDoc(path);
      if (path === "quotes/inv1") {
        return { ...r, get: () => (++quoteReads === 1 ? Promise.reject(new Error("unavailable")) : r.get()) };
      }
      if (path === "paymentLinks/link1") {
        return { ...r, update: (p: Record<string, unknown>) => (++linkUpdates === 1 ? Promise.reject(new Error("unavailable")) : r.update(p)) };
      }
      return r;
    });
    expect((await deliver()).status).toBe(503);
    expect(link()).toMatchObject({ status: "paid" });
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });
    spy.mockRestore();

    await deliver();
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
    expect(link().invoiceSettledAt).toBeInstanceOf(Date);
    await flushAfterResponse();
    expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
    await deliver();
    expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
  });

  it("refuses a partial payment: amount below requested_amount", async () => {
    verifyAnswer = () => verified({ reference: REF, amount: 40_000, requested_amount: 45_000 });
    expect((await deliver()).status).toBe(200);
    expect(link().status).toBe("open");
    expect(link().attention).toMatch(/does not match/i);
  });

  it("still records the payment when the agency has since switched Payments off", async () => {
    mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", paymentsEnabledByAgency: false });
    await deliver();
    expect(link().status).toBe("paid");
  });

  it("compares requested_amount, so customer-borne fees don't strand a real payment", async () => {
    verifyAnswer = () => verified({ reference: REF, amount: 46_300, requested_amount: 45_000 });
    await deliver();
    expect(link().status).toBe("paid");
  });

  it("refuses when requested_amount differs, even if amount happens to match", async () => {
    verifyAnswer = () => verified({ reference: REF, amount: 45_000, requested_amount: 100 });
    await deliver();
    expect(link().status).toBe("open");
    expect(link().attention).toMatch(/does not match/i);
  });
});

describe("test mode vs live mode — judged by the checkout ATTEMPT", () => {
  function deliverLive() {
    const body = event();
    const signature = createHmac("sha512", LIVE_KEY).update(body).digest("hex");
    return POST(
      new Request(`http://app.local/api/webhooks/paystack/sa/${SA}`, {
        method: "POST",
        headers: { "x-paystack-signature": signature },
        body,
      }),
      { params: Promise.resolve({ subAccountId: SA }) },
    );
  }

  it("records a test-mode payment for a test attempt, with Paystack's domain", async () => {
    await deliver();
    expect(link()).toMatchObject({ status: "paid", paystackDomain: "test" });
    expect(mem.read(`paymentAttempts/${REF}`)).toMatchObject({ state: "settled" });
  });

  it("records a live payment for a live attempt", async () => {
    seedSub(SA, LIVE_KEY);
    seedAttempt(REF, { secretKey: LIVE_KEY });
    verifyAnswer = () => verified({ reference: REF, domain: "live" });
    expect((await deliverLive()).status).toBe(200);
    expect(link()).toMatchObject({ status: "paid", paystackDomain: "live" });
  });

  it("refuses a test-mode transaction for a live attempt — flagged, never paid, 200", async () => {
    seedSub(SA, LIVE_KEY);
    seedAttempt(REF, { secretKey: LIVE_KEY });
    verifyAnswer = () => verified({ reference: REF, domain: "test" });
    expect((await deliverLive()).status).toBe(200);
    expect(link().status).toBe("open");
    expect(link().attention).toMatch(/test-mode payment/i);
    expect(mem.read(`paymentAttempts/${REF}`)).toMatchObject({ state: "flagged" });
  });

  it("refuses a live transaction for a test attempt", async () => {
    verifyAnswer = () => verified({ reference: REF, domain: "live" });
    await deliver();
    expect(link().status).toBe("open");
    expect(link().attention).toMatch(/live-mode payment/i);
  });

  it("refuses, without asking Paystack, when the verifying key is not the attempt's key", async () => {
    seedAttempt(REF, { secretKey: OTHER_KEY }); // opened under another test key
    expect((await deliver()).status).toBe(200);
    expect(link().status).toBe("open");
    expect(calls).toEqual([]);
    expect(link().attention).toMatch(/different key/i);
    expect(mem.read(`paymentAttempts/${REF}`)).toMatchObject({ state: "flagged" });
  });

  it("flags, never pays, a verified payment for a checkout with no attempt — once per reference", async () => {
    await mem.db.doc(`paymentAttempts/${REF}`).delete();
    expect((await deliver()).status).toBe(200);
    await deliver();
    expect(link().status).toBe("open");
    expect(String(link().attention).match(new RegExp(REF, "g"))).toHaveLength(1);
  });

  it("refuses an attempt recorded for another link", async () => {
    seedAttempt(REF, { paymentLinkId: "link9" });
    await deliver();
    expect(link().status).toBe("open");
    expect(calls).toEqual([]);
  });

  it("refuses an attempt recorded for another sub-account", async () => {
    seedAttempt(REF, { subAccountId: OTHER_SA });
    await deliver();
    expect(link().status).toBe("open");
    expect(calls).toEqual([]);
  });
});

describe("double payment — recorded on the link, never overwriting the first", () => {
  const FIRST = "pl-link1-ffffffffffffffff";

  it("keeps the first reference and records the second as an extra payment", async () => {
    seedLink("link1", { status: "paid", paystackReference: FIRST });
    await deliver();
    expect(link().paystackReference).toBe(FIRST);
    expect(link().extraPayments).toEqual([
      expect.objectContaining({ reference: REF, amountCents: 45000 }),
    ]);
  });

  it("records a redelivered second payment only once", async () => {
    seedLink("link1", { status: "paid", paystackReference: FIRST });
    await deliver();
    await deliver();
    expect(link().extraPayments).toHaveLength(1);
  });
});

describe("invoice cannot be marked — link paid, flagged for the operator", () => {
  it("does not mark an invoice paid whose total changed after the link was made", async () => {
    seedInvoice("inv1", { globalTaxPercent: null }); // R1,000 now; link and payment R1,150
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    await deliver();
    expect(link().status).toBe("paid");
    expect(link().invoiceAttention).toMatch(/changed/i);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });
    await flushAfterResponse();
    expect(effects.fireQuoteTrigger).not.toHaveBeenCalled();
  });

  it("does not mark an invoice paid whose currency changed", async () => {
    seedInvoice("inv1", { currency: "USD" });
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    await deliver();
    expect(link().invoiceAttention).toBeTruthy();
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });
  });

  it("flags an invoice that went back to draft", async () => {
    seedInvoice("inv1", { status: "draft" });
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    await deliver();
    expect(link().status).toBe("paid");
    expect(link().invoiceAttention).toBeTruthy();
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "draft" });
  });

  it("flags an invoice genuinely paid another way (manual mark first) — a refund may be owed", async () => {
    seedInvoice("inv1", { status: "paid", paidVia: null });
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    await deliver();
    expect(link().status).toBe("paid");
    expect(link().invoiceAttention).toMatch(/already paid/i);
    await flushAfterResponse();
    expect(effects.fireQuoteTrigger).not.toHaveBeenCalled();
  });

  it("flags an invoice paid by a DIFFERENT Paystack link — same rail is not the same payment", async () => {
    seedInvoice("inv1", {
      status: "paid",
      paidVia: { rail: "paystack_link", linkId: "link2", reference: "pl-link2-aaaaaaaaaaaaaaaa" },
    });
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    await deliver();
    expect(link().invoiceAttention).toMatch(/already paid/i);
  });

  it("a failing side effect after the invoice's paid commit neither flags nor retries", async () => {
    seedInvoice();
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    effects.recordQuoteActivity.mockRejectedValueOnce(new Error("boom"));
    expect((await deliver()).status).toBe(200);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
    expect(link().invoiceAttention ?? null).toBeNull();
    expect(link().invoiceSettledAt).toBeInstanceOf(Date);
    await flushAfterResponse();
    expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
  });

  it("writes the attention on redelivery when the first attention write failed", async () => {
    seedInvoice("inv1", { globalTaxPercent: null }); // changed since the link
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    const realDoc = mem.db.doc;
    let linkUpdates = 0;
    const spy = vi.spyOn(mem.db, "doc").mockImplementation((path: string) => {
      const r = realDoc(path);
      return path === "paymentLinks/link1"
        ? { ...r, update: (p: Record<string, unknown>) => (++linkUpdates === 1 ? Promise.reject(new Error("unavailable")) : r.update(p)) }
        : r;
    });
    expect((await deliver()).status).toBe(503);
    expect(link().invoiceAttention ?? null).toBeNull();
    spy.mockRestore();
    await deliver();
    expect(link().invoiceAttention).toMatch(/changed/i);
    expect(link().invoiceSettledAt).toBeInstanceOf(Date);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "sent" });
  });

  it("leaves a clean invoice payment unflagged", async () => {
    seedInvoice();
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000 });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    await deliver();
    expect(link().invoiceAttention ?? null).toBeNull();
  });
});

describe("refusals — 200 so Paystack doesn't retry, and never paid", () => {
  it("rejects a forged signature with 401 before asking Paystack anything", async () => {
    const res = await deliver({ key: OTHER_KEY });
    expect(res.status).toBe(401);
    expect(link().status).toBe("open");
    expect(calls).toEqual([]);
  });

  it("refuses when Paystack's amount differs from the link's", async () => {
    verifyAnswer = () => verified({ reference: REF, amount: 100 });
    expect((await deliver()).status).toBe(200);
    expect(link().status).toBe("open");
    expect(link().attention).toMatch(/does not match/i);
  });

  it("does not trust the webhook body's amount — only Paystack's verify answer", async () => {
    verifyAnswer = () => verified({ reference: REF, amount: 100 });
    // The signed body claims the right amount; verify says otherwise.
    await deliver({ body: event() });
    expect(link().status).toBe("open");
  });

  it("refuses when the currency differs", async () => {
    verifyAnswer = () => verified({ reference: REF, currency: "NGN" });
    await deliver();
    expect(link().status).toBe("open");
    expect(link().attention).toMatch(/does not match/i);
  });

  it("refuses a transaction Paystack says did not succeed", async () => {
    verifyAnswer = () => verified({ reference: REF, status: "abandoned" });
    await deliver();
    expect(link().status).toBe("open");
    // Not a success, so nothing was received: no flag.
    expect(link().attention ?? null).toBeNull();
  });

  it("refuses a verify answer for a different reference", async () => {
    verifyAnswer = () => verified({ reference: "pl-link1-aaaaaaaaaaaaaaaa" });
    await deliver();
    expect(link().status).toBe("open");
  });

  it("refuses a reference whose link belongs to another sub-account", async () => {
    seedSub(OTHER_SA, OTHER_KEY);
    // Correctly signed by sa2's own key, naming sa1's link.
    const res = await deliver({ sa: OTHER_SA, key: OTHER_KEY });
    expect(res.status).toBe(200);
    expect(link().status).toBe("open");
    expect(calls).toEqual([]);
  });

  it("ignores references that are not payment links", async () => {
    const res = await deliver({ body: event("T123456789") });
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("ignores events other than charge.success", async () => {
    await deliver({ body: event(REF, "transfer.success") });
    expect(calls).toEqual([]);
    expect(link().status).toBe("open");
  });
});

describe("Paystack unreachable", () => {
  it("answers 503 so Paystack redelivers, and marks nothing", async () => {
    verifyAnswer = () => "network-error";
    expect((await deliver()).status).toBe(503);
    expect(link().status).toBe("open");
  });

  it.each([
    [400, "Transaction reference not found"],
    [404, "Transaction not found"],
  ])("treats a genuine not-found (%i) as final (200)", async (status, message) => {
    verifyAnswer = () => refused(status, message);
    expect((await deliver()).status).toBe(200);
    expect(link().status).toBe("open");
  });

  it.each([
    [429, "Too many requests"],
    [401, "Invalid key"],
    [403, "Forbidden"],
    [400, "Something else went wrong"],
    [500, "Internal error"],
  ])("answers 503 to a %i refusal so a real payment is redelivered", async (status, message) => {
    verifyAnswer = () => refused(status, message);
    expect((await deliver()).status).toBe(503);
    expect(link().status).toBe("open");
  });
});
