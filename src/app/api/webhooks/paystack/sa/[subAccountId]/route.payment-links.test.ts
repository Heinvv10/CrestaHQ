import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KEY,
  OTHER_KEY,
  OTHER_SA,
  SA,
  mem,
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
 * review ask) are stubbed — the fan-out mocks are how "exactly once" is
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
    expect(effects.recordQuoteActivity).toHaveBeenCalledTimes(1);
    expect(effects.fireQuoteTrigger).toHaveBeenCalledTimes(1);
  });

  it("finishes the invoice on a replay if the first delivery marked only the link", async () => {
    seedInvoice();
    seedLink("link1", { invoiceId: "inv1", amountCents: 115000, status: "paid", paystackReference: REF });
    verifyAnswer = () => verified({ reference: REF, amount: 115000 });
    await deliver();
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "paid" });
  });

  it("never lets a second, different payment overwrite the first", async () => {
    seedLink("link1", { status: "paid", paystackReference: "pl-link1-ffffffffffffffff" });
    await deliver();
    expect(link().paystackReference).toBe("pl-link1-ffffffffffffffff");
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
  });

  it("refuses a transaction Paystack says did not succeed", async () => {
    verifyAnswer = () => verified({ reference: REF, status: "abandoned" });
    await deliver();
    expect(link().status).toBe("open");
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

  it("treats Paystack refusing the reference as final (200)", async () => {
    verifyAnswer = () => ({ status: 400, body: { status: false, message: "Transaction reference not found" } });
    expect((await deliver()).status).toBe(200);
    expect(link().status).toBe("open");
  });
});
