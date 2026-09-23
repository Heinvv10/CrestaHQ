import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KEY,
  LIVE_KEY,
  SA,
  mem,
  seedAttempt,
  seedInvoice,
  seedLink,
  seedSub,
  stubPaystack,
  verified,
} from "@/test/paystack-links-harness";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";

/**
 * Seam test: the REAL webhook route → reconciler → mandate write, over an
 * in-memory Firestore. Paying a card-on-file link settles the invoice AND
 * saves the card — only from Paystack's verify answer, only for a payment
 * that matched its attempt, only when the authorization is reusable.
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

const { POST } = await import("./route");

const REF = "pl-link1-0123456789abcdef";
const TERMS = {
  amountCents: 115000,
  currency: "ZAR",
  frequency: "every month",
  text: "By paying, you authorise Acme to charge this card R 1,150.00 every month.",
};
const CONSENT = { text: TERMS.text, acceptedAt: new Date("2026-09-23T08:00:00Z"), ip: "198.51.100.7" };
const AUTH = {
  authorization_code: "AUTH_verified01",
  reusable: true,
  channel: "card",
  card_type: "visa",
  brand: "visa",
  last4: "4081",
  exp_month: "12",
  exp_year: "2030",
  signature: "SIG_card01",
};

function deliver(body = JSON.stringify({ event: "charge.success", data: { reference: REF } }), key = KEY) {
  const signature = createHmac("sha512", key).update(body).digest("hex");
  return POST(
    new Request(`http://app.local/api/webhooks/paystack/sa/${SA}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paystack-signature": signature },
      body,
    }),
    { params: Promise.resolve({ subAccountId: SA }) },
  );
}

const mandates = () => mem.list("paymentMandates");
let authorization: Record<string, unknown> | undefined;
let over: Record<string, unknown>;

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  seedSub();
  seedInvoice("inv1", { recurringInvoiceId: "rec1" });
  seedLink("link1", {
    invoiceId: "inv1",
    contactId: "c1",
    amountCents: 115000,
    recurringInvoiceId: "rec1",
    mandate: TERMS,
  });
  seedAttempt(REF, { amountCents: 115000, consent: CONSENT });
  authorization = AUTH;
  over = {};
  stubPaystack(() =>
    verified({
      reference: REF,
      amount: 115000,
      channel: "card",
      customer: { email: "payer@example.com", customer_code: "CUS_payer01" },
      authorization,
      ...over,
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("card-on-file link paid via the verified webhook", () => {
  it("settles the invoice and stores the mandate, secret split from display", async () => {
    expect((await deliver()).status).toBe(200);

    expect(mem.read("paymentLinks/link1")).toMatchObject({ status: "paid", mandateId: REF, mandateAttention: null });
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });

    const all = mandates();
    expect(all).toHaveLength(1);
    const m = mem.read(`paymentMandates/${REF}`)!;
    expect(m).toMatchObject({
      agencyId: "ag1",
      subAccountId: SA,
      createdByUid: "u1",
      contactId: "c1",
      recurringInvoiceId: "rec1",
      paymentLinkId: "link1",
      reference: REF,
      terms: TERMS,
      consent: CONSENT,
      cardBrand: "visa",
      last4: "4081",
      expMonth: "12",
      expYear: "2030",
      mode: "test",
      keyFingerprint: paystackKeyFingerprint(KEY),
      status: "active",
      attention: null,
    });
    // Nothing on the member-readable doc can charge the card.
    expect(JSON.stringify(m)).not.toContain("AUTH_");
    expect(JSON.stringify(m)).not.toContain("CUS_");
    expect(mem.read(`paymentMandates/${REF}/private/authorization`)).toEqual({
      authorizationCode: "AUTH_verified01",
      customerCode: "CUS_payer01",
      email: "payer@example.com",
      signature: "SIG_card01",
    });
  });

  it("takes the authorization from Paystack's verify answer, never the webhook body", async () => {
    const body = JSON.stringify({
      event: "charge.success",
      data: { reference: REF, authorization: { ...AUTH, authorization_code: "AUTH_forged" } },
    });
    await deliver(body);
    expect(mem.read(`paymentMandates/${REF}/private/authorization`)).toMatchObject({ authorizationCode: "AUTH_verified01" });
  });

  it("a non-reusable authorization settles the invoice but saves no card, and says why", async () => {
    authorization = { ...AUTH, reusable: false };
    await deliver();
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
    expect(mandates()).toHaveLength(0);
    expect(mem.read("paymentLinks/link1")).toMatchObject({ status: "paid", mandateId: null });
    expect(mem.read("paymentLinks/link1")!.mandateAttention).toMatch(/card was not saved/i);
  });

  it("no authorization code, or no customer code → no card saved", async () => {
    authorization = { ...AUTH, authorization_code: "" };
    await deliver();
    expect(mandates()).toHaveLength(0);
    expect(mem.read("paymentLinks/link1")!.mandateAttention).toMatch(/card was not saved/i);

    mem.clear();
    seedSub();
    seedInvoice("inv1", { recurringInvoiceId: "rec1" });
    seedLink("link1", { invoiceId: "inv1", contactId: "c1", amountCents: 115000, recurringInvoiceId: "rec1", mandate: TERMS });
    seedAttempt(REF, { amountCents: 115000, consent: CONSENT });
    authorization = AUTH;
    over = { customer: { email: "payer@example.com" } };
    await deliver();
    expect(mandates()).toHaveLength(0);
    expect(mem.read("paymentLinks/link1")!.mandateAttention).toMatch(/card was not saved/i);
  });

  it("no customer email on verify → no card saved (Paystack charges an authorization only with it)", async () => {
    over = { customer: { customer_code: "CUS_payer01" } };
    await deliver();
    expect(mandates()).toHaveLength(0);
    expect(mem.read("paymentLinks/link1")!.mandateAttention).toMatch(/card was not saved/i);
  });

  it("a card link that lost its schedule id saves no card", async () => {
    seedLink("link1", { invoiceId: "inv1", contactId: "c1", amountCents: 115000, recurringInvoiceId: null, mandate: TERMS });
    await deliver();
    expect(mandates()).toHaveLength(0);
    expect(mem.read("paymentLinks/link1")!.mandateAttention).toMatch(/card was not saved/i);
  });

  it("a payment by a non-card channel saves no card", async () => {
    over = { channel: "bank" };
    authorization = { ...AUTH, channel: "bank" };
    await deliver();
    expect(mandates()).toHaveLength(0);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
  });

  it("an attempt without consent evidence saves no card", async () => {
    seedAttempt(REF, { amountCents: 115000, consent: null });
    await deliver();
    expect(mandates()).toHaveLength(0);
    expect(mem.read("paymentLinks/link1")!.mandateAttention).toMatch(/card was not saved/i);
  });

  it("an ordinary invoice link with a reusable authorization saves no card", async () => {
    seedLink("link1", { invoiceId: "inv1", contactId: "c1", amountCents: 115000, mandate: null, recurringInvoiceId: null });
    await deliver();
    expect(mem.read("paymentLinks/link1")).toMatchObject({ status: "paid" });
    expect(mandates()).toHaveLength(0);
    expect(mem.read("paymentLinks/link1")!.mandateAttention).toBeUndefined();
  });

  it("a replayed webhook creates one mandate and leaves it as it was", async () => {
    await deliver();
    mem.seed(`paymentMandates/${REF}`, { ...mem.read(`paymentMandates/${REF}`)!, status: "revoked" });
    await deliver();
    expect(mandates()).toHaveLength(1);
    expect(mem.read(`paymentMandates/${REF}`)).toMatchObject({ status: "revoked" });
  });

  it("a live-domain payment on a test attempt stores nothing and marks nothing paid", async () => {
    over = { domain: "live" };
    await deliver();
    expect(mandates()).toHaveLength(0);
    expect(mem.read("paymentLinks/link1")).toMatchObject({ status: "open" });
  });

  it("verified with a key other than the attempt's stores nothing", async () => {
    seedSub(SA, LIVE_KEY);
    await deliver(undefined, LIVE_KEY);
    expect(mandates()).toHaveLength(0);
    expect(mem.read("paymentLinks/link1")).toMatchObject({ status: "open" });
  });

  it("a second payment on an already-paid link saves no second card", async () => {
    await deliver();
    const REF2 = "pl-link1-fedcba9876543210";
    seedAttempt(REF2, { amountCents: 115000, consent: CONSENT });
    stubPaystack(() =>
      verified({
        reference: REF2,
        amount: 115000,
        channel: "card",
        customer: { email: "payer@example.com", customer_code: "CUS_payer01" },
        authorization: { ...AUTH, authorization_code: "AUTH_second" },
      }),
    );
    await deliver(JSON.stringify({ event: "charge.success", data: { reference: REF2 } }));
    expect(mandates()).toHaveLength(1);
    expect(mem.read(`paymentMandates/${REF2}`)).toBeUndefined();
  });
});
