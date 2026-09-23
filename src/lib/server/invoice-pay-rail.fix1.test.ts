import { beforeEach, describe, expect, it, vi } from "vitest";

import { SA, mem, seedInvoice, seedSchedule, seedSub } from "@/test/paystack-links-harness";

/**
 * Fix round 1 (PR #225), through the same seam as `invoice-pay-rail.test.ts`:
 * the REAL send → rail → `createPaymentLink` → `loadPayableLink`.
 *
 *   R1 — a re-send after a price edit must email a link that can be paid;
 *   R2 — an invoice whose card charge is pending or unconfirmed gets no pay
 *        link, and an existing link for it can't be paid;
 *   R3 — a card-on-file link that can't be made falls through to the next rail;
 *   H3 — a Stripe tenant keeps Stripe even when Paystack is connected too.
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
process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

const { sendQuoteServerSide } = await import("./quote-send-service");
const { loadPayableLink } = await import("./payment-links-service");

const send = () =>
  sendQuoteServerSide({ subAccountId: SA, quoteId: "inv1", actor: { kind: "system", reason: "test" } });
const quote = () => mem.read("quotes/inv1")!;
const links = () => mem.list("paymentLinks");
const emailedToken = () =>
  /\/pay\/link\/(\S+)/.exec((sendEmail.mock.calls.at(-1)![0] as { text: string }).text)![1];
const sub = (over: Record<string, unknown>) => mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, ...over });
const edit = (over: Record<string, unknown>) => mem.seed("quotes/inv1", { ...quote(), ...over });
const pricier = { lineItems: [{ id: "li1", description: "Install", quantity: 1, unitPrice: 2000 }] };

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  sendEmail.mockResolvedValue(undefined);
  seedSub(); // Payments on, Paystack connected, no PayPal, no Stripe.
  mem.seed("contacts/c1", { email: "payer@example.com", name: "Pat" });
  seedInvoice("inv1", { status: "draft", createdByUid: "u7", recurringInvoiceId: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("R1: a re-send after an edit emails a payable link", () => {
  it("first send fails at email, the price is edited, the re-send's link can be paid", async () => {
    sendEmail.mockRejectedValueOnce(new Error("SMTP down"));
    expect(await send()).toMatchObject({ ok: false });
    edit(pricier);
    expect(await send()).toMatchObject({ ok: true });
    const res = await loadPayableLink(emailedToken());
    expect(res).toMatchObject({ ok: true, link: { amountCents: 230000 } });
    // The stale link is withdrawn, not left open beside the new one.
    expect(links().filter((l) => l.active)).toHaveLength(1);
  });

  it("an already-sent invoice, edited and re-sent: the new link can be paid", async () => {
    expect(await send()).toMatchObject({ ok: true });
    const first = emailedToken();
    edit(pricier);
    expect(await send()).toMatchObject({ ok: true });
    expect(emailedToken()).not.toBe(first);
    expect((await loadPayableLink(emailedToken())).ok).toBe(true);
    expect(await loadPayableLink(first)).toMatchObject({ ok: false, status: 410 });
  });
});

describe("R2: a pending or unconfirmed card charge gets no pay link", () => {
  const charge = (state: string) => ({ reference: "ra-sch1-c1", mandateId: "m1", state, reason: null });

  it.each(["pending", "unknown", "paid", "needs_attention"])("refuses to send when the charge is %s", async (state) => {
    edit({ status: "sent", autoCharge: charge(state) });
    const res = await send();
    expect(res).toMatchObject({ ok: false, failure: { code: "card_charge_unsettled", status: 409 } });
    if (!res.ok) expect(res.failure.error).toContain("mark the invoice paid, instead of sending a pay link");
    expect(links()).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a declined charge is the fallback, and still sends", async () => {
    edit({ status: "sent", autoCharge: charge("declined") });
    expect(await send()).toMatchObject({ ok: true });
    expect((await loadPayableLink(emailedToken())).ok).toBe(true);
  });

  it("an existing link can't be paid once a charge is pending", async () => {
    expect(await send()).toMatchObject({ ok: true });
    edit({ autoCharge: charge("pending") });
    expect(await loadPayableLink(emailedToken())).toMatchObject({ ok: false, status: 409 });
  });
});

describe("R3 + H3: rail order", () => {
  it("R3: a card-mode invoice on a PayPal tenant with no business name falls through to paypal.me, with the reason", async () => {
    seedSchedule("rec1", { chargeMode: "card" });
    edit({ recurringInvoiceId: "rec1" });
    sub({ name: "", paypalConfig: { username: "acme" } });
    const res = await send();
    expect(res).toMatchObject({ ok: true });
    expect(quote().paymentLinkUrl).toMatch(/^https:\/\/paypal\.me\/acme\//);
    if (res.ok) {
      expect(res.cardLinkFallback).toContain("business name");
      expect(res.cardLinkFallback).toContain("PayPal");
    }
    expect(links()).toHaveLength(0);
  });

  it("H3: a Stripe + Paystack ZAR tenant keeps Stripe: no Paystack link", async () => {
    sub({ stripeConnectionMeta: { ready: true } });
    expect(await send()).toMatchObject({ ok: true, paymentLinkUrl: null, cardLinkFallback: null });
    expect(links()).toHaveLength(0);
  });

  it("a card-mode invoice on a Stripe + Paystack tenant still gets the card-on-file link", async () => {
    seedSchedule("rec1", { chargeMode: "card" });
    edit({ recurringInvoiceId: "rec1" });
    sub({ stripeConnectionMeta: { ready: true } });
    expect(await send()).toMatchObject({ ok: true, cardLinkFallback: null });
    expect(links()[0].mandate).toBeTruthy();
  });
});
