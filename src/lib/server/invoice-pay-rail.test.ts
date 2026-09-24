import { beforeEach, describe, expect, it, vi } from "vitest";

import { SA, mem, seedInvoice, seedSchedule, seedSub } from "@/test/paystack-links-harness";

/**
 * Seam test: the REAL `sendQuoteServerSide` → `chooseInvoicePayRail` →
 * `createPaymentLink` over an in-memory Firestore, with the real email
 * renderer. Only the email transport and the lifecycle side-effects are
 * stubbed, so what a test reads off `sendEmail` is what the customer gets.
 */

const sendEmail = vi.fn();
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => true,
  sendEmail: (...a: unknown[]) => sendEmail(...a),
  tenantFrom: () => "Acme <billing@example.com>",
}));
vi.mock("@/lib/quotes/lifecycle", () => ({
  recordQuoteActivity: async () => undefined,
  fireQuoteTrigger: async () => undefined,
  emitQuoteWebhook: async () => undefined,
}));
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-16";
process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com/";

const { sendQuoteServerSide } = await import("./quote-send-service");
const { loadPayableLink } = await import("./payment-links-service");

const PAY = /https:\/\/app\.example\.com\/pay\/link\/(\S+)/;
const send = () =>
  sendQuoteServerSide({ subAccountId: SA, quoteId: "inv1", actor: { kind: "system", reason: "test" } });
const quote = () => mem.read("quotes/inv1")!;
const links = () => mem.list("paymentLinks");
const emailText = () => (sendEmail.mock.calls.at(-1)![0] as { text: string }).text;
const sub = (over: Record<string, unknown>) => mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, ...over });

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  sendEmail.mockResolvedValue(undefined);
  seedSub(); // Payments on, Paystack connected, no PayPal, no Stripe.
  mem.seed("contacts/c1", { subAccountId: SA, email: "payer@example.com", name: "Pat" });
  seedInvoice("inv1", { status: "draft", createdByUid: "u7", recurringInvoiceId: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("Paystack-only workspace", () => {
  it("sends a ZAR invoice with a Paystack pay link in the email and on the invoice", async () => {
    const res = await send();
    expect(res).toMatchObject({ ok: true, sentTo: "payer@example.com" });
    const [link] = links();
    expect(links()).toHaveLength(1);
    expect(link).toMatchObject({ invoiceId: "inv1", createdByUid: "u7", amountCents: 115000, active: true });
    expect(link.mandate).toBeUndefined();
    const url = `https://app.example.com/pay/link/${link.token}`;
    expect(emailText()).toContain(url);
    expect(quote()).toMatchObject({ status: "sent", paymentLinkUrl: url, paymentLinkId: link.id });
    if (res.ok) expect(res.paymentLinkUrl).toBe(url);
    // Now sent, the link can be paid.
    expect((await loadPayableLink(link.token as string)).ok).toBe(true);
  });

  it("refuses a non-ZAR invoice: no rail, no link, no email", async () => {
    seedInvoice("inv1", { status: "draft", currency: "USD" });
    const res = await send();
    expect(res).toMatchObject({ ok: false, failure: { code: "no_payment_rail", status: 503 } });
    if (!res.ok) expect(res.failure.error).toBe("Connect Paystack, Stripe or PayPal under Settings → Payments before sending invoices.");
    expect(links()).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses when the agency has Payments off", async () => {
    sub({ paymentsEnabledByAgency: false });
    expect(await send()).toMatchObject({ ok: false, failure: { code: "no_payment_rail" } });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses when Paystack isn't connected", async () => {
    mem.seed(`subAccounts/${SA}/private/paystackConnection`, {});
    expect(await send()).toMatchObject({ ok: false, failure: { code: "no_payment_rail" } });
  });

  it("the draft allowance is for drafts only: a paid invoice gets no link and no email", async () => {
    seedInvoice("inv1", { status: "paid" });
    // Refused before any rail is chosen (sendQuoteServerSide's paid guard).
    expect(await send()).toMatchObject({ ok: false, failure: { code: "already_paid", status: 409 } });
    expect(links()).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a re-send reuses the same open link and token", async () => {
    await send();
    const first = PAY.exec(emailText())![1];
    await send();
    expect(links()).toHaveLength(1);
    expect(PAY.exec(emailText())![1]).toBe(first);
  });

  it("a link minted for a send that then fails cannot be paid while the invoice is a draft", async () => {
    sendEmail.mockRejectedValueOnce(new Error("SMTP down"));
    expect(await send()).toMatchObject({ ok: false, failure: { code: "send_failed" } });
    expect(quote().status).toBe("draft");
    const [link] = links();
    expect(await loadPayableLink(link.token as string)).toMatchObject({ ok: false, status: 410 });
  });
});

describe("card-mode recurring invoice", () => {
  beforeEach(() => {
    seedSchedule("rec1", { chargeMode: "card" });
    seedInvoice("inv1", { status: "draft", createdByUid: "u7", recurringInvoiceId: "rec1" });
  });

  it("gets a card-on-file link, even with PayPal configured", async () => {
    sub({ paypalConfig: { username: "acme" } });
    expect(await send()).toMatchObject({ ok: true });
    const [link] = links();
    expect(link.mandate).toMatchObject({ amountCents: 115000, currency: "ZAR" });
    expect(link.recurringInvoiceId).toBe("rec1");
    expect(emailText()).toContain(`/pay/link/${link.token}`);
    expect(quote().paymentLinkUrl).toBe(`https://app.example.com/pay/link/${link.token}`);
  });

  it("falls through to a plain Paystack link, and says why, when the card-on-file link can't be made", async () => {
    // The invoice was edited away from the schedule's amount.
    seedInvoice("inv1", { status: "draft", recurringInvoiceId: "rec1", globalTaxPercent: 0 });
    const res = await send();
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.cardLinkFallback).toContain("differs from its recurring schedule");
    const [link] = links();
    expect(link.mandate).toBeUndefined();
    expect(link.amountCents).toBe(100000);
    expect(emailText()).toContain(`/pay/link/${link.token}`);
  });

  it("a billing-day pro-rata gets a plain Paystack link, and no fallback to 'fix'", async () => {
    seedInvoice("inv1", { status: "draft", recurringInvoiceId: "rec1", globalTaxPercent: 0, prorated: "gap" });
    const res = await send();
    expect(res).toMatchObject({ ok: true, cardLinkFallback: null });
    const [link] = links();
    expect(link.mandate).toBeUndefined();
    expect(link.amountCents).toBe(100000);
  });
});

describe("unchanged rails", () => {
  it("PayPal on an invoice-mode schedule: paypal.me, no Paystack link, no pay line", async () => {
    seedSchedule("rec1", { chargeMode: "invoice" });
    seedInvoice("inv1", { status: "draft", recurringInvoiceId: "rec1" });
    sub({ paypalConfig: { username: "acme" } });
    expect(await send()).toMatchObject({ ok: true });
    expect(quote().paymentLinkUrl).toMatch(/^https:\/\/paypal\.me\/acme\//);
    expect(quote().paymentLinkId).toBeNull();
    expect(links()).toHaveLength(0);
    expect(emailText()).not.toContain("Or pay now");
  });

  it("Stripe only (Paystack not connected): sends with no link minted", async () => {
    mem.seed(`subAccounts/${SA}/private/paystackConnection`, {});
    sub({ stripeConnectionMeta: { ready: true } });
    expect(await send()).toMatchObject({ ok: true, paymentLinkUrl: null });
    expect(links()).toHaveLength(0);
    expect(quote().paymentLinkUrl).toBeUndefined();
  });
});
