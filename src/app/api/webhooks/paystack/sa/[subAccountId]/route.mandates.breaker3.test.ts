import { createHmac } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KEY, SA, mem, seedAttempt, seedInvoice, seedLink, seedSchedule, seedSub, verified } from "@/test/paystack-links-harness";

/**
 * Adversarial-review round 3 (all held): consent ordering across Firestore
 * Timestamps and Dates, a revoke followed by a fresh card, a schedule deleted
 * mid-settle, and a recurring cycle racing a card settle on the schedule doc.
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
vi.mock("@/lib/quotes/number", () => ({ issueQuoteNumber: vi.fn(async () => "INV-2026-0099") }));
vi.mock("@/lib/auth/territory-filter", () => ({ territoryForContact: vi.fn(async () => null) }));
vi.mock("@/lib/server/quote-send-service", () => ({ sendQuoteServerSide: vi.fn(async () => ({ ok: true })) }));
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-16";

const { POST } = await import("./route");
const { revokePaymentMandate } = await import("@/lib/server/payment-mandates");
const { runOneSchedule } = await import("@/lib/server/recurring-invoice-service");

const REF1 = "pl-link1-0123456789abcdef";
const REF2 = "pl-link2-fedcba9876543210";
const TERMS = { amountCents: 115000, currency: "ZAR", frequency: "every month", text: "By paying, you authorise Acme Fibre ..." };
const consentAt = (at: Date | Timestamp) => ({ text: TERMS.text, acceptedAt: at, ip: "198.51.100.7" });

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
        authorization: { authorization_code: `AUTH_${reference}`, reusable: true, channel: "card", brand: "visa", last4: "4242", exp_month: "12", exp_year: "2030", signature: null },
      });
      return new Response(JSON.stringify(a.body), { status: 200 });
    }),
  );
}

const status = (id: string) => (mem.read(`paymentMandates/${id}`) as { status?: string } | undefined)?.status;

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  seedSub();
  seedSchedule("rec1");
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

describe("round 3: revoke then a fresh card link", () => {
  it("R3-1 operator revokes the card, customer pays a fresh card link → the new card saves", async () => {
    seedAttempt(REF1, { amountCents: 115000, consent: consentAt(new Date("2026-09-01T08:00:00Z")) });
    await deliver(REF1);
    expect(status(REF1)).toBe("active");
    expect(await revokePaymentMandate({ subAccountId: SA, mandateId: REF1, uid: "u1" })).toMatchObject({ ok: true });
    seedAttempt(REF2, { amountCents: 115000, consent: consentAt(new Date("2026-09-02T08:00:00Z")) });
    await deliver(REF2);
    expect(status(REF2)).toBe("active");
    expect(mem.read("recurringInvoices/rec1")).toMatchObject({ cardMandateId: REF2 });
  });
});

describe("round 3: consent time types", () => {
  it("R3-2 an existing mandate's Timestamp consent (as Firestore returns it) is compared with a Date consent", async () => {
    // Stored mandate authorised LATER, consent held as an admin Timestamp.
    mem.seed("paymentMandates/pl-linkX-aaaaaaaaaaaaaaaa", {
      subAccountId: SA,
      recurringInvoiceId: "rec1",
      status: "active",
      consent: consentAt(Timestamp.fromDate(new Date("2026-09-10T08:00:00Z"))),
    });
    seedAttempt(REF1, { amountCents: 115000, consent: consentAt(new Date("2026-09-01T08:00:00Z")) });
    await deliver(REF1);
    expect(status(REF1)).toBeUndefined();
    expect(status("pl-linkX-aaaaaaaaaaaaaaaa")).toBe("active");
    expect(String(mem.read("paymentLinks/link1")!.mandateAttention)).toMatch(/more recently/);
  });

  it("R3-3 a new consent held as a Timestamp beats an older Date consent", async () => {
    mem.seed("paymentMandates/pl-linkX-aaaaaaaaaaaaaaaa", {
      subAccountId: SA,
      recurringInvoiceId: "rec1",
      status: "active",
      consent: consentAt(new Date("2026-08-01T08:00:00Z")),
    });
    seedAttempt(REF1, { amountCents: 115000, consent: consentAt(Timestamp.fromDate(new Date("2026-09-01T08:00:00Z"))) });
    await deliver(REF1);
    expect(status(REF1)).toBe("active");
    expect(status("pl-linkX-aaaaaaaaaaaaaaaa")).toBe("revoked");
  });

  it("R3-4 a legacy mandate with no consent never blocks a new card", async () => {
    mem.seed("paymentMandates/pl-linkX-aaaaaaaaaaaaaaaa", { subAccountId: SA, recurringInvoiceId: "rec1", status: "revoked" });
    seedAttempt(REF1, { amountCents: 115000, consent: consentAt(new Date("2026-09-01T08:00:00Z")) });
    await deliver(REF1);
    expect(status(REF1)).toBe("active");
  });
});

describe("round 3: schedule doc writes", () => {
  it("R3-5 schedule deleted between the settle tx's read and its commit → paid, no card, no throw, reason recorded", async () => {
    seedAttempt(REF1, { amountCents: 115000, consent: consentAt(new Date("2026-09-01T08:00:00Z")) });
    const real = mem.db.runTransaction.bind(mem.db);
    let once = false;
    vi.spyOn(mem.db, "runTransaction").mockImplementation(((fn: (t: unknown) => Promise<unknown>) =>
      real(async (t: unknown) => {
        const r = await fn(t);
        if (!once) {
          once = true;
          await mem.db.doc("recurringInvoices/rec1").delete();
        }
        return r;
      })) as never);
    expect((await deliver(REF1)).status).toBe(200);
    expect(mem.read("paymentLinks/link1")).toMatchObject({ status: "paid", mandateId: null });
    expect(String(mem.read("paymentLinks/link1")!.mandateAttention)).toMatch(/schedule changed or stopped/);
    expect(mem.read("recurringInvoices/rec1")).toBeUndefined();
    expect(status(REF1)).toBeUndefined();
  });

  it("R3-6 a recurring cycle claimed in the middle of a card settle: both land, neither clobbers the other", async () => {
    seedSchedule("rec1", { nextRunAt: Timestamp.fromDate(new Date("2026-09-01T00:00:00Z")), reviewFirst: true, cyclesGenerated: 0, createdByUid: "u1", unpaidEscalationThreshold: 0 });
    seedAttempt(REF1, { amountCents: 115000, consent: consentAt(new Date("2026-09-01T08:00:00Z")) });
    const real = mem.db.runTransaction.bind(mem.db);
    let once = false;
    let cycle: unknown;
    vi.spyOn(mem.db, "runTransaction").mockImplementation(((fn: (t: unknown) => Promise<unknown>) =>
      real(async (t: unknown) => {
        const r = await fn(t);
        if (!once && (mem.read(`paymentLinks/link1`) as { status?: string }).status === "open") {
          once = true;
          // The cycle claims and advances the schedule while the settle tx is between read and commit.
          cycle = await runOneSchedule("rec1", new Date("2026-09-01T06:00:00Z"));
        }
        return r;
      })) as never);
    expect((await deliver(REF1)).status).toBe(200);
    expect(cycle).toMatchObject({ kind: "generated" });
    const s = mem.read("recurringInvoices/rec1")!;
    expect(s).toMatchObject({ cardMandateId: REF1, cyclesGenerated: 1 });
    expect(status(REF1)).toBe("active");
  });
});
