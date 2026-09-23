import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KEY, OTHER_KEY, SA, mem, seedAttempt, seedInvoice, seedLink, seedSchedule, seedSub, verified } from "@/test/paystack-links-harness";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";

/**
 * Adversarial-review repros (round 1): each asserts the SAFE outcome. The
 * card is saved only if, inside the transaction that marks the link paid,
 * the link is still live, the schedule still matches the terms agreed to,
 * and the connection still holds the key the card was taken under — and a
 * newer card for a schedule replaces the older one.
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
const { flagStaleMandates } = await import("@/lib/server/payment-mandates");
const { deactivatePaymentLink } = await import("@/lib/server/payment-links-service");

const REF = "pl-link1-0123456789abcdef";
const TERMS = { amountCents: 115000, currency: "ZAR", frequency: "every month", text: "By paying, you authorise Acme ..." };
const CONSENT = { text: TERMS.text, acceptedAt: new Date("2026-09-23T08:00:00Z"), ip: "198.51.100.7" };
const AUTH = { authorization_code: "AUTH_v", reusable: true, channel: "card", brand: "visa", last4: "4081", exp_month: "12", exp_year: "2030", signature: "SIG" };

function deliver(reference = REF, key = KEY) {
  const body = JSON.stringify({ event: "charge.success", data: { reference } });
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

/** fetch stub whose verify answer can run an async side effect first (an interleaving). */
function stubVerify(beforeAnswer: (reference: string) => Promise<void> = async () => {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const reference = new URL(url).pathname.split("/").pop()!;
      await beforeAnswer(reference);
      const a = verified({
        reference,
        amount: 115000,
        channel: "card",
        customer: { email: "payer@example.com", customer_code: "CUS_1" },
        authorization: AUTH,
      });
      return new Response(JSON.stringify(a.body), { status: 200 });
    }),
  );
}

const activeMandates = () => mem.list("paymentMandates").filter((m) => (m as { status?: string }).status === "active");

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  seedSub();
  seedSchedule("rec1");
  seedInvoice("inv1", { recurringInvoiceId: "rec1" });
  seedLink("link1", { invoiceId: "inv1", contactId: "c1", amountCents: 115000, recurringInvoiceId: "rec1", mandate: TERMS });
  seedAttempt(REF, { amountCents: 115000, consent: CONSENT });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("breaker: mandate outlives the terms it was consented under", () => {
  it("B1 schedule paused between checkout and settle → no ACTIVE mandate", async () => {
    stubVerify();
    seedSchedule("rec1", { status: "paused" });
    await deliver();
    expect(mem.read("paymentLinks/link1")).toMatchObject({ status: "paid" });
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
    expect(activeMandates()).toHaveLength(0);
    expect(String(mem.read("paymentLinks/link1")!.mandateAttention)).toMatch(/schedule changed/i);
  });

  it("B2 schedule re-priced between checkout and settle → no ACTIVE mandate on the old terms", async () => {
    stubVerify();
    seedSchedule("rec1", { lineItems: [{ id: "li1", description: "Install", quantity: 1, unitPrice: 2000 }] });
    await deliver();
    expect(activeMandates()).toHaveLength(0);
    expect(String(mem.read("paymentLinks/link1")!.mandateAttention)).toMatch(/schedule changed/i);
  });
});

describe("breaker: withdrawn link", () => {
  it("B3 operator deactivated the card link, customer completes the open checkout → no ACTIVE mandate", async () => {
    stubVerify();
    expect(await deactivatePaymentLink({ subAccountId: SA, linkId: "link1" })).toMatchObject({ ok: true });
    await deliver();
    expect(activeMandates()).toHaveLength(0);
    expect(String(mem.read("paymentLinks/link1")!.mandateAttention)).toMatch(/withdrawn/i);
  });
});

describe("breaker: one schedule, many mandates", () => {
  it("B4 two cycles' card links both paid → at most one ACTIVE mandate for the schedule", async () => {
    stubVerify();
    await deliver();
    const REF2 = "pl-link2-fedcba9876543210";
    seedInvoice("inv2", { recurringInvoiceId: "rec1", quoteNumber: "INV-2026-0002" });
    seedLink("link2", { invoiceId: "inv2", contactId: "c1", amountCents: 115000, recurringInvoiceId: "rec1", mandate: TERMS });
    // The next cycle's card, authorised later.
    seedAttempt(REF2, { amountCents: 115000, consent: { ...CONSENT, acceptedAt: new Date("2026-10-23T08:00:00Z") } });
    await deliver(REF2);
    const forRec1 = activeMandates().filter((m) => (m as { recurringInvoiceId?: string }).recurringInvoiceId === "rec1");
    expect(forRec1).toHaveLength(1);
    // The newer card replaces the older, which can never be charged again.
    expect(forRec1[0].id).toBe(REF2);
    expect(mem.read(`paymentMandates/${REF}`)).toMatchObject({ status: "revoked" });
    expect(mem.read(`paymentMandates/${REF}/private/authorization`)).toBeUndefined();
    expect(mem.read(`paymentMandates/${REF2}/private/authorization`)).toBeDefined();
  });
});

describe("breaker: key change races an in-flight settle", () => {
  it("B5 key replaced (and stranded mandates flagged) while verify is in flight → mandate is not ACTIVE under the old key", async () => {
    stubVerify(async () => {
      // What the connection POST does between this webhook's key read and its commit.
      mem.seed(`subAccounts/${SA}/private/paystackConnection`, { secretKey: OTHER_KEY });
      await flagStaleMandates(SA, paystackKeyFingerprint(OTHER_KEY));
    });
    await deliver();
    expect(activeMandates()).toHaveLength(0);
    expect(mem.read("paymentLinks/link1")).toMatchObject({ status: "paid" });
    expect(String(mem.read("paymentLinks/link1")!.mandateAttention)).toMatch(/connection changed/i);
  });

  it("B6 disconnected while verify is in flight → mandate is not ACTIVE", async () => {
    stubVerify(async () => {
      await mem.db.doc(`subAccounts/${SA}/private/paystackConnection`).delete();
      await flagStaleMandates(SA, null);
    });
    await deliver();
    expect(activeMandates()).toHaveLength(0);
    expect(String(mem.read("paymentLinks/link1")!.mandateAttention)).toMatch(/connection changed/i);
  });
});

describe("round-1 fix: the re-checks are reads of the settle transaction itself", () => {
  /** Run `change` after the transaction's first pass read everything, before it commits. */
  function interleave(change: () => void) {
    const realTx = mem.db.runTransaction;
    let done = false;
    vi.spyOn(mem.db, "runTransaction").mockImplementation((fn) =>
      realTx(async (t) => {
        const result = await fn(t);
        if (!done) {
          done = true;
          change();
        }
        return result;
      }),
    );
  }

  it("a key change committing mid-transaction retries it, and no active mandate is left", async () => {
    stubVerify();
    interleave(() => mem.seed(`subAccounts/${SA}/private/paystackConnection`, { secretKey: OTHER_KEY }));
    await deliver();
    expect(activeMandates()).toHaveLength(0);
    expect(String(mem.read("paymentLinks/link1")!.mandateAttention)).toMatch(/connection changed/i);
  });

  it("a schedule paused mid-transaction retries it, and no active mandate is left", async () => {
    stubVerify();
    interleave(() => seedSchedule("rec1", { status: "paused" }));
    await deliver();
    expect(activeMandates()).toHaveLength(0);
    expect(String(mem.read("paymentLinks/link1")!.mandateAttention)).toMatch(/schedule changed/i);
  });

  it("replacing leaves an already-revoked older mandate's record as it was", async () => {
    stubVerify();
    const revokedAt = new Date("2026-09-01T00:00:00Z");
    mem.seed("paymentMandates/old1", { subAccountId: SA, recurringInvoiceId: "rec1", status: "revoked", revokedByUid: "u1", revokedAt, attention: null });
    await deliver();
    expect(mem.read("paymentMandates/old1")).toMatchObject({ status: "revoked", revokedByUid: "u1", revokedAt, attention: null });
    expect(activeMandates()).toHaveLength(1);
  });

  it("replacing never touches another sub-account's mandates on a same-named schedule", async () => {
    stubVerify();
    mem.seed("paymentMandates/theirs", { subAccountId: "sa2", recurringInvoiceId: "rec1", status: "active" });
    mem.seed("paymentMandates/theirs/private/authorization", { authorizationCode: "AUTH_theirs" });
    await deliver();
    expect(mem.read("paymentMandates/theirs")).toMatchObject({ status: "active" });
    expect(mem.read("paymentMandates/theirs/private/authorization")).toBeDefined();
  });
});
