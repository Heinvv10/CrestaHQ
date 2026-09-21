import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behaviour-pinning tests for the SEND-AND-PERSIST half of the send route:
 * minting the public token, building its URL, the Resend call itself, the
 * Firestore lifecycle write, and the activity / trigger / webhook side-effects.
 *
 * Two behaviours pinned here are deliberately preserved oddities of the
 * pre-extraction route, NOT endorsements: a failed lifecycle write is swallowed
 * while the side-effects still fire, and a provider rejection must leave the
 * quote unsent. Changing either is its own change with its own review.
 *
 * Shared fakes live in ./send-test-harness. Siblings:
 *   route.access.test.ts        — configuration, tenancy, territory, recipient
 *   route.payment-rails.test.ts — invoice rails + the PayPal link
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
  QUOTE_ID,
  SUB_ID,
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

describe("token + public URL", () => {
  it("500s when the token can't be minted", async () => {
    state.tokenThrows = new Error("no secret");
    const { status, body } = await call();
    expect(status).toBe(500);
    expect(body.error).toBe(
      "Failed to mint quote token. Check AUTOMATIONS_TOKEN_SECRET is configured.",
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("503s when the public URL can't be built", async () => {
    state.publicUrl = null;
    const { status, body } = await call();
    expect(status).toBe(503);
    expect(body.error).toBe(
      "NEXT_PUBLIC_APP_URL isn't configured — set it so quote links resolve.",
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("send", () => {
  it("uses workspace SMTP configuration when platform email is unavailable", async () => {
    state.emailConfigured = false;
    state.subDoc = { ...state.subDoc, emailProvider: "smtp" };
    const { status } = await call();
    expect(status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      subAccount: expect.objectContaining({ emailProvider: "smtp" }),
      meter: { subAccountId: SUB_ID },
    }));
  });

  it("sends with the caller as Reply-To and the tenant From", async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, sentTo: "recipient@example.com" });
    expect(sendEmail).toHaveBeenCalledWith({
      to: "recipient@example.com",
      subject: "Quote from Acme",
      text: "text-body",
      html: "<p>html-body</p>",
      replyTo: "operator@example.com",
      from: "tenant-from:Acme Plumbing",
      subAccount: state.subDoc,
      meter: { subAccountId: SUB_ID },
    });
    expect(renderQuoteEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        businessName: "Acme Plumbing",
        businessLogoUrl: "https://cdn.example.com/logo.png",
        recipientName: "Jane Doe",
        publicUrl: "https://app.example.com/q/tok_abc",
      }),
    );
  });

  it("falls back to a placeholder business name when the sub-account is missing", async () => {
    state.subDoc = null;
    await call();
    expect(renderQuoteEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        businessName: "Your business",
        businessLogoUrl: null,
      }),
    );
  });

  it("502s when the provider rejects, and does NOT mark the quote sent", async () => {
    sendEmail.mockRejectedValueOnce(new Error("mailbox full"));
    const { status, body } = await call();
    expect(status).toBe(502);
    expect(body.error).toBe("Send failed: mailbox full");
    expect(state.quoteUpdates).toHaveLength(0);
    expect(recordQuoteActivity).not.toHaveBeenCalled();
    expect(fireQuoteTrigger).not.toHaveBeenCalled();
    expect(emitQuoteWebhook).not.toHaveBeenCalled();
  });
});

describe("lifecycle", () => {
  it("writes status sent, resets viewedAt and stores the token hash", async () => {
    await call();
    expect(state.quoteUpdates).toHaveLength(1);
    expect(state.quoteUpdates[0]).toEqual({
      status: "sent",
      sentAt: "__SERVER_TS__",
      viewedAt: null,
      publicTokenHash: "hash_abc",
      updatedAt: "__SERVER_TS__",
    });
  });

  it("records a first send with no extra", async () => {
    await call();
    expect(recordQuoteActivity).toHaveBeenCalledWith(
      expect.objectContaining({ id: QUOTE_ID }),
      "quote_sent",
      { extra: null },
    );
  });

  it("records a re-send when the quote had already left draft", async () => {
    state.quoteDoc = baseQuote({ status: "viewed" });
    await call();
    expect(recordQuoteActivity).toHaveBeenCalledWith(
      expect.anything(),
      "quote_sent",
      { extra: "re-sent" },
    );
  });

  it("fires the trigger and the outbound webhook", async () => {
    await call();
    expect(fireQuoteTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: QUOTE_ID }),
      "quote_sent",
    );
    expect(emitQuoteWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ id: QUOTE_ID }),
      "quote_sent",
    );
  });

  it("swallows a failed lifecycle write and still reports success", async () => {
    state.quoteUpdateThrows = new Error("firestore unavailable");
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, sentTo: "recipient@example.com" });
    expect(recordQuoteActivity).toHaveBeenCalledTimes(1);
  });
});
