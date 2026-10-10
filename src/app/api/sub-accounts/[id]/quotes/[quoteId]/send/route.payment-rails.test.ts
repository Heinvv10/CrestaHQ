import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * Behaviour-pinning tests for the invoice PAYMENT RAILS on the send route.
 *
 * An invoice may only be sent when the recipient can actually pay it: either a
 * ready Stripe connection (the card button renders live on /q/[token]) or a
 * PayPal username (a paypal.me URL minted here). A quote requires neither.
 *
 * The PayPal URL builder and the money math are REAL here rather than mocked —
 * both are pure, and the exact minted URL is what a customer clicks.
 *
 * Shared fakes live in ./send-test-harness. Siblings:
 *   route.access.test.ts — configuration, tenancy, territory, recipient guards
 *   route.send.test.ts   — token, send, lifecycle write, side-effects
 */

vi.mock("firebase-admin/firestore", async () =>
  (await import("./send-test-harness")).firestoreMock(),
);
vi.mock("@/lib/firebase/admin", async () =>
  (await import("./send-test-harness")).adminMock(),
);
vi.mock("@/lib/auth/require-tenancy", async () =>
  (await import("./send-test-harness")).tenancyMock(),
);
vi.mock("@/lib/auth/territory-filter", async () =>
  (await import("./send-test-harness")).territoryMock(),
);
vi.mock("@/lib/comms/resend", async () =>
  (await import("./send-test-harness")).resendMock(),
);
vi.mock("@/lib/quotes/token", async () =>
  (await import("./send-test-harness")).tokenMock(),
);
vi.mock("@/lib/quotes/email", async () =>
  (await import("./send-test-harness")).emailMock(),
);
vi.mock("@/lib/quotes/lifecycle", async () =>
  (await import("./send-test-harness")).lifecycleMock(),
);

import {
  baseQuote,
  callJson,
  emitQuoteWebhook,
  fireQuoteTrigger,
  recordQuoteActivity,
  renderQuoteEmail,
  resetHarness,
  sendEmail,
  state,
} from "./send-test-harness";
import { POST } from "./route";

const call = () => callJson(POST);

beforeEach(resetHarness);

describe("invoice payment rails", () => {
  it("503s an invoice with neither PayPal nor a ready card connection", async () => {
    state.quoteDoc = baseQuote({ kind: "invoice", quoteNumber: "INV-2026-0001" });
    state.subDoc = { name: "Acme Plumbing" };
    const { status, body } = await call();
    expect(status).toBe(503);
    expect(body.error).toBe(
      "Connect Paystack, Stripe or PayPal under Settings → Payments before sending invoices.",
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("503s when Stripe is ready but the agency gate is off", async () => {
    state.quoteDoc = baseQuote({ kind: "invoice" });
    state.subDoc = {
      name: "Acme Plumbing",
      paymentsEnabledByAgency: false,
      stripeConnectionMeta: { ready: true },
    };
    expect((await call()).status).toBe(503);
  });

  it("503s when the agency gate is on but the connection isn't ready", async () => {
    state.quoteDoc = baseQuote({ kind: "invoice" });
    state.subDoc = {
      name: "Acme Plumbing",
      paymentsEnabledByAgency: true,
      stripeConnectionMeta: { ready: false },
    };
    expect((await call()).status).toBe(503);
  });

  it("mints a fresh paypal.me link on EVERY send and persists it", async () => {
    state.quoteDoc = baseQuote({
      kind: "invoice",
      status: "sent",
      paymentLinkUrl: "https://paypal.me/acme/999USD",
      paymentLinkId: "stale",
    });
    state.subDoc = { name: "Acme Plumbing", paypalConfig: { username: "acme" } };

    const { status, body } = await call();
    expect(status).toBe(200);
    // 2 × 50 = 100 → integer formatting, USD suffix.
    expect(body.paymentLinkUrl).toBe("https://paypal.me/acme/100USD");
    expect(state.quoteUpdates[0]).toMatchObject({
      paymentLinkUrl: "https://paypal.me/acme/100USD",
      paymentLinkId: null,
      paymentLinkMintedAt: "__SERVER_TS__",
    });
  });

  it("hands the FRESH link to the email and every side-effect consumer", async () => {
    // The persisted document and the in-memory object are updated separately.
    // If the in-memory reset is lost, Firestore still reads correctly while the
    // customer is emailed a link for the PREVIOUS amount and webhook
    // subscribers receive a dead payment-link id — a divergence no assertion on
    // the stored document can see.
    state.quoteDoc = baseQuote({
      kind: "invoice",
      status: "sent",
      paymentLinkUrl: "https://paypal.me/acme/999USD",
      paymentLinkId: "stale_link_id",
    });
    state.subDoc = { name: "Acme Plumbing", paypalConfig: { username: "acme" } };

    await call();

    const fresh = {
      paymentLinkUrl: "https://paypal.me/acme/100USD",
      paymentLinkId: null,
    };
    expect(renderQuoteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ quote: expect.objectContaining(fresh) }),
    );
    for (const consumer of [
      recordQuoteActivity,
      fireQuoteTrigger,
      emitQuoteWebhook,
    ]) {
      await flushAfterResponse();
      expect(consumer).toHaveBeenCalledWith(
        expect.objectContaining(fresh),
        "quote_sent",
        ...(consumer === recordQuoteActivity ? [{ extra: "re-sent" }] : []),
      );
    }
  });

  it("sends on a card-only connection and mints NO payment link", async () => {
    state.quoteDoc = baseQuote({ kind: "invoice" });
    state.subDoc = {
      name: "Acme Plumbing",
      paymentsEnabledByAgency: true,
      stripeConnectionMeta: { ready: true },
    };
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.paymentLinkUrl).toBeNull();
    expect(state.quoteUpdates[0]).not.toHaveProperty("paymentLinkUrl");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("500s when the PayPal link can't be built", async () => {
    state.quoteDoc = baseQuote({ kind: "invoice", lineItems: [] });
    state.subDoc = { name: "Acme Plumbing", paypalConfig: { username: "acme" } };
    const { status, body } = await call();
    expect(status).toBe(500);
    expect(String(body.error)).toContain("Failed to build PayPal link:");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("requires no payment rail at all for a quote", async () => {
    state.subDoc = { name: "Acme Plumbing" };
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.paymentLinkUrl).toBeNull();
  });
});
