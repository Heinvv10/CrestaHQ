import { vi } from "vitest";

import { paystackKeyFingerprint, paystackKeyMode } from "@/lib/paystack/key-fingerprint";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Shared fixture for the Paystack payment-link seam tests: an in-memory
 * Firestore behind `getAdminDb`, and a `fetch` stub standing in for Paystack.
 *
 *   vi.mock("@/lib/firebase/admin", async () =>
 *     (await import("@/test/paystack-links-harness")).adminMock());
 *
 * No app imports that reach the admin module — a mock factory that imported
 * it would deadlock. (`key-fingerprint` is pure.)
 */

export const mem = createMemoryFirestore();
export const adminMock = () => ({ getAdminDb: () => mem.db });

export const SA = "sa1";
export const OTHER_SA = "sa2";
export const AGENCY = "ag1";
// Tiny fixtures so gitleaks does not read test data as real keys.
export const KEY = "sk_test_k1";
export const OTHER_KEY = "sk_test_k2";
export const LIVE_KEY = "sk_live_k3";

export function seedSub(subAccountId = SA, secretKey = KEY) {
  mem.seed(`subAccounts/${subAccountId}`, {
    agencyId: AGENCY,
    paymentsEnabledByAgency: true,
    paystackConnectionMeta: { webhookSeenAt: null, livemode: secretKey.startsWith("sk_live_") },
  });
  mem.seed(`subAccounts/${subAccountId}/private/paystackConnection`, { secretKey });
}

/** R1,150.00 — 1000 + 15% tax. */
export function seedInvoice(id = "inv1", over: Record<string, unknown> = {}) {
  mem.seed(`quotes/${id}`, {
    agencyId: AGENCY,
    subAccountId: SA,
    contactId: "c1",
    kind: "invoice",
    status: "sent",
    quoteNumber: "INV-2026-0001",
    currency: "ZAR",
    lineItems: [{ id: "li1", description: "Install", quantity: 1, unitPrice: 1000 }],
    globalDiscount: null,
    globalTaxPercent: 15,
    ...over,
  });
}

/** A monthly recurring schedule whose template totals R1,150.00, like `seedInvoice`. */
export function seedSchedule(id = "rec1", over: Record<string, unknown> = {}) {
  mem.seed(`recurringInvoices/${id}`, {
    agencyId: AGENCY,
    subAccountId: SA,
    contactId: "c1",
    status: "active",
    currency: "ZAR",
    lineItems: [{ id: "li1", description: "Install", quantity: 1, unitPrice: 1000 }],
    globalDiscount: null,
    globalTaxPercent: 15,
    cadence: { unit: "month", interval: 1 },
    ...over,
  });
}

export function seedLink(id = "link1", over: Record<string, unknown> = {}) {
  mem.seed(`paymentLinks/${id}`, {
    agencyId: AGENCY,
    subAccountId: SA,
    createdByUid: "u1",
    invoiceId: null,
    contactId: null,
    description: "Call-out fee",
    amountCents: 45000,
    currency: "ZAR",
    mode: "test",
    token: "unused",
    active: true,
    status: "open",
    paystackReference: null,
    payerEmail: null,
    paidAt: null,
    ...over,
  });
}

/**
 * The attempt a checkout would have recorded for `reference`
 * (`pl-{linkId}-{nonce}`): open, in the mode of `secretKey`, for the link's
 * default R450.00.
 */
export function seedAttempt(reference: string, over: Record<string, unknown> & { secretKey?: string } = {}) {
  const { secretKey = KEY, ...rest } = over;
  mem.seed(`paymentAttempts/${reference}`, {
    agencyId: AGENCY,
    subAccountId: SA,
    createdByUid: "u1",
    paymentLinkId: /^pl-([A-Za-z0-9]+)-/.exec(reference)?.[1] ?? null,
    amountCents: 45000,
    currency: "ZAR",
    mode: paystackKeyMode(secretKey),
    keyFingerprint: paystackKeyFingerprint(secretKey),
    state: "open",
    reason: null,
    ...rest,
  });
}

export interface PaystackCall {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

/**
 * Paystack stand-in. `respond` decides each answer; every call is recorded so
 * a test can assert what was (or was not) asked, and with whose key.
 */
export function stubPaystack(
  respond: (call: PaystackCall) => { status?: number; body: unknown } | "network-error",
) {
  const calls: PaystackCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: PaystackCall = {
        method: init.method ?? "GET",
        path: new URL(url).pathname,
        auth: new Headers(init.headers).get("authorization"),
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      const answer = respond(call);
      if (answer === "network-error") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
    }),
  );
  return calls;
}

/**
 * A `GET /transaction/verify` success envelope. `requested_amount` follows
 * `amount` unless given — they differ only when the customer bears the fees.
 */
export function verified(over: Record<string, unknown> & { reference: string }) {
  const amount = over.amount ?? 45000;
  return {
    body: {
      status: true,
      data: {
        status: "success",
        domain: "test",
        amount,
        requested_amount: amount,
        currency: "ZAR",
        customer: { email: "payer@example.com" },
        ...over,
      },
    },
  };
}

/** A Paystack refusal envelope at the given HTTP status. */
export function refused(status: number, message: string) {
  return { status, body: { status: false, message } };
}
