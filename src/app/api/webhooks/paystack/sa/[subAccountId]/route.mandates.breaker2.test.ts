import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KEY, SA, mem, seedAttempt, seedInvoice, seedLink, seedSchedule, seedSub, verified } from "@/test/paystack-links-harness";

/**
 * Adversarial-review repros (round 2): which card a schedule keeps is decided
 * by when the customer CONSENTED, not by when a webhook happened to settle,
 * and concurrent settles for one schedule leave one chargeable card.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
vi.mock("@/lib/quotes/lifecycle", () => ({
  recordQuoteActivity: vi.fn(async () => {}),
  fireQuoteTrigger: vi.fn(async () => {}),
  emitQuoteWebhook: vi.fn(async () => {}),
}));
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: vi.fn(async () => {}) }));
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-16";

const { POST } = await import("./route");

const REF1 = "pl-link1-0123456789abcdef";
const REF2 = "pl-link2-fedcba9876543210";
const TERMS = { amountCents: 115000, currency: "ZAR", frequency: "every month", text: "By paying, you authorise Acme Fibre ..." };
const consentAt = (iso: string) => ({ text: TERMS.text, acceptedAt: new Date(iso), ip: "198.51.100.7" });

function deliver(reference: string) {
  const body = JSON.stringify({ event: "charge.success", data: { reference } });
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

function stubVerify() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const reference = new URL(url).pathname.split("/").pop()!;
      const a = verified({
        reference,
        amount: 115000,
        channel: "card",
        customer: { email: "payer@example.com", customer_code: "CUS_1" },
        authorization: { authorization_code: `AUTH_${reference}`, reusable: true, channel: "card", brand: "visa", last4: reference === REF1 ? "1111" : "2222", exp_month: "12", exp_year: "2030", signature: null },
      });
      return new Response(JSON.stringify(a.body), { status: 200 });
    }),
  );
}

const status = (id: string) => (mem.read(`paymentMandates/${id}`) as { status?: string } | undefined)?.status;
const active = () => mem.list("paymentMandates").filter((m) => (m as { status?: string }).status === "active");

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  seedSub();
  seedSchedule("rec1");
  // Two cycles of one schedule, each with its own card link.
  seedInvoice("inv1", { recurringInvoiceId: "rec1" });
  seedInvoice("inv2", { recurringInvoiceId: "rec1", quoteNumber: "INV-2026-0002" });
  seedLink("link1", { invoiceId: "inv1", contactId: "c1", amountCents: 115000, recurringInvoiceId: "rec1", mandate: TERMS });
  seedLink("link2", { invoiceId: "inv2", contactId: "c1", amountCents: 115000, recurringInvoiceId: "rec1", mandate: TERMS });
  stubVerify();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("round 2: supersede orders by settle time, not by consent", () => {
  it("R2-1 an OLDER consent whose webhook is redelivered late does not revoke the customer's NEWER card", async () => {
    // Customer agreed on link1 at T0 (card ••1111); its webhook failed and Paystack redelivers later.
    seedAttempt(REF1, { amountCents: 115000, consent: consentAt("2026-09-01T08:00:00Z") });
    // A month on they pay link2 with a new card (••2222), consent at T1 > T0. Settles first.
    seedAttempt(REF2, { amountCents: 115000, consent: consentAt("2026-10-01T08:00:00Z") });
    expect((await deliver(REF2)).status).toBe(200);
    expect(status(REF2)).toBe("active");

    // Late redelivery of the T0 payment.
    expect((await deliver(REF1)).status).toBe(200);

    // Safe: the newest consent's card stays the one chargeable card.
    expect(status(REF2)).toBe("active");
    expect(active()).toHaveLength(1);
    // The late payment still settles its invoice, and says why no card was kept.
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
    expect(String(mem.read("paymentLinks/link1")!.mandateAttention)).toMatch(/more recently/i);
    expect(mem.read("recurringInvoices/rec1")).toMatchObject({ cardMandateId: REF2 });
  });

  it("an older consent arriving after the operator revoked the newer card saves nothing", async () => {
    seedAttempt(REF1, { amountCents: 115000, consent: consentAt("2026-09-01T08:00:00Z") });
    seedAttempt(REF2, { amountCents: 115000, consent: consentAt("2026-10-01T08:00:00Z") });
    await deliver(REF2);
    mem.seed(`paymentMandates/${REF2}`, { ...mem.read(`paymentMandates/${REF2}`)!, status: "revoked" });
    await deliver(REF1);
    expect(active()).toHaveLength(0);
    expect(mem.read(`paymentMandates/${REF1}`)).toBeUndefined();
  });
});

describe("round 2: a tie in consent time keeps the card already saved", () => {
  it("equal consent times: the second to settle saves nothing", async () => {
    seedAttempt(REF1, { amountCents: 115000, consent: consentAt("2026-09-01T08:00:00Z") });
    seedAttempt(REF2, { amountCents: 115000, consent: consentAt("2026-09-01T08:00:00Z") });
    await deliver(REF1);
    await deliver(REF2);
    expect([status(REF1), status(REF2)]).toEqual(["active", undefined]);
  });
});

describe("round 2: concurrent settles on one schedule (memory-Firestore query phantom)", () => {
  it("R2-2 two card links of one schedule settling concurrently leave at most one active mandate", async () => {
    seedAttempt(REF1, { amountCents: 115000, consent: consentAt("2026-09-01T08:00:00Z") });
    seedAttempt(REF2, { amountCents: 115000, consent: consentAt("2026-09-01T08:01:00Z") });
    await Promise.all([deliver(REF1), deliver(REF2)]);
    expect(active()).toHaveLength(1);
  });
});

describe("round 2: what held (expected GREEN)", () => {
  it("H1 a replay of the superseded card's own payment does not resurrect it or revoke the newer", async () => {
    seedAttempt(REF1, { amountCents: 115000, consent: consentAt("2026-09-01T08:00:00Z") });
    seedAttempt(REF2, { amountCents: 115000, consent: consentAt("2026-10-01T08:00:00Z") });
    await deliver(REF1);
    await deliver(REF2);
    expect([status(REF1), status(REF2)]).toEqual(["revoked", "active"]);
    expect(mem.read(`paymentMandates/${REF1}/private/authorization`)).toBeUndefined();
    await deliver(REF1);
    expect([status(REF1), status(REF2)]).toEqual(["revoked", "active"]);
  });

  it("H2 supersede never crosses schedules or sub-accounts", async () => {
    seedSchedule("rec2");
    mem.seed("paymentMandates/other-sched", { subAccountId: SA, recurringInvoiceId: "rec2", status: "active" });
    mem.seed("paymentMandates/other-sa", { subAccountId: "sa2", recurringInvoiceId: "rec1", status: "active" });
    seedAttempt(REF1, { amountCents: 115000, consent: consentAt("2026-09-01T08:00:00Z") });
    await deliver(REF1);
    expect([status("other-sched"), status("other-sa"), status(REF1)]).toEqual(["active", "active", "active"]);
  });

  it("H3 an ordinary (non-card) link settles without reading schedule/connection/mandates in the tx", async () => {
    seedLink("link1", { invoiceId: "inv1", contactId: "c1", amountCents: 115000, mandate: null, recurringInvoiceId: null });
    seedAttempt(REF1, { amountCents: 115000 });
    const spy = vi.spyOn(mem.db, "collection");
    await deliver(REF1);
    expect(mem.read("paymentLinks/link1")).toMatchObject({ status: "paid" });
    expect(spy.mock.calls.filter(([c]) => c === "paymentMandates")).toHaveLength(0);
  });
});

describe("round 2: a replaced card leaves no visible trace where the operator looks", () => {
  it("R2-3 after link2's card replaces link1's, link1 no longer claims a saved card without saying why", async () => {
    seedAttempt(REF1, { amountCents: 115000, consent: consentAt("2026-09-01T08:00:00Z") });
    seedAttempt(REF2, { amountCents: 115000, consent: consentAt("2026-10-01T08:00:00Z") });
    await deliver(REF1);
    await deliver(REF2);
    expect(status(REF1)).toBe("revoked");
    const link1 = mem.read("paymentLinks/link1") as { mandateId?: string | null; mandateAttention?: string | null };
    // The link records the card it saved at the time; the mandate — what the
    // contact page shows — says it was replaced, and by which payment.
    expect(link1.mandateId).toBe(REF1);
    expect(String(mem.read(`paymentMandates/${REF1}`)!.attention)).toContain(REF2);
    expect(mem.read("recurringInvoices/rec1")).toMatchObject({ cardMandateId: REF2 });
  });
});
