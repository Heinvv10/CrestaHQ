import { vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Shared fixture for the Paystack payment-link seam tests: an in-memory
 * Firestore behind `getAdminDb`, and a `fetch` stub standing in for Paystack.
 *
 *   vi.mock("@/lib/firebase/admin", async () =>
 *     (await import("@/test/paystack-links-harness")).adminMock());
 *
 * No app imports — a mock factory that imported the admin module would
 * deadlock.
 */

export const mem = createMemoryFirestore();
export const adminMock = () => ({ getAdminDb: () => mem.db });

export const SA = "sa1";
export const OTHER_SA = "sa2";
export const AGENCY = "ag1";
// Tiny fixtures so gitleaks does not read test data as real keys.
export const KEY = "sk_test_k1";
export const OTHER_KEY = "sk_test_k2";

export function seedSub(subAccountId = SA, secretKey = KEY) {
  mem.seed(`subAccounts/${subAccountId}`, {
    agencyId: AGENCY,
    paymentsEnabledByAgency: true,
    paystackConnectionMeta: { webhookSeenAt: null },
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
    token: "unused",
    active: true,
    status: "open",
    paystackReference: null,
    payerEmail: null,
    paidAt: null,
    ...over,
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

/** A `GET /transaction/verify` success envelope. */
export function verified(over: Record<string, unknown> & { reference: string }) {
  return {
    body: {
      status: true,
      data: { status: "success", amount: 45000, currency: "ZAR", customer: { email: "payer@example.com" }, ...over },
    },
  };
}
