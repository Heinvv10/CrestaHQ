import { Timestamp } from "firebase-admin/firestore";

import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";
import { AGENCY, KEY, SA, mem, stubPaystack, verified, type PaystackCall } from "@/test/paystack-links-harness";

/**
 * Fixture for the recurring card-cycle seam tests (W5 PR3), over the same
 * in-memory Firestore and Paystack `fetch` stub as the payment-link tests.
 * Mock `@/lib/firebase/admin` with `paystack-links-harness`'s `adminMock`.
 */

export const SCHEDULE = "sch1";
export const MANDATE = "m1";
/** R1,150.00 — 1000 + 15% tax, the terms the customer agreed to. */
export const AMOUNT = 115000;
export const TERMS = { amountCents: AMOUNT, currency: "ZAR", frequency: "every month", text: "By paying…" };
/** 1 Mar 2026 07:00 SAST: the schedule's cycle is due. */
export const NOW = new Date("2026-03-01T05:00:00.000Z");
/** The reference the next cycle (cyclesGenerated 3 → 4) charges under. */
export const REF = `ra-${SCHEDULE}-c4`;

export function seedCardSchedule(over: Record<string, unknown> = {}) {
  mem.seed(`recurringInvoices/${SCHEDULE}`, {
    agencyId: AGENCY,
    subAccountId: SA,
    createdByUid: "u1",
    contactId: "c1",
    name: "Acme retainer",
    status: "active",
    currency: "ZAR",
    lineItems: [{ id: "li1", description: "Fibre", quantity: 1, unitPrice: 1000 }],
    globalDiscount: null,
    globalTaxPercent: 15,
    termsAndNotes: "",
    billedToOrganization: null,
    billingAddress: null,
    paymentDueDays: 7,
    cadence: { unit: "month", interval: 1 },
    anchorDay: 1,
    timezone: "Africa/Johannesburg",
    nextRunAt: Timestamp.fromDate(new Date("2026-02-28T22:00:00.000Z")),
    endMode: "never",
    endAt: null,
    maxCycles: null,
    reviewFirst: false,
    unpaidEscalationThreshold: 2,
    cyclesGenerated: 3,
    outstandingInvoices: 0,
    lastEscalatedCount: null,
    lastError: null,
    chargeMode: "card",
    cardMandateId: MANDATE,
    ...over,
  });
}

export function seedMandate(over: Record<string, unknown> = {}, secretKey = KEY) {
  mem.seed(`paymentMandates/${MANDATE}`, {
    agencyId: AGENCY,
    subAccountId: SA,
    createdByUid: "u1",
    contactId: "c1",
    recurringInvoiceId: SCHEDULE,
    paymentLinkId: "link1",
    reference: MANDATE,
    terms: TERMS,
    mode: "test",
    keyFingerprint: paystackKeyFingerprint(secretKey),
    status: "active",
    attention: null,
    ...over,
  });
  mem.seed(`paymentMandates/${MANDATE}/private/authorization`, {
    authorizationCode: "AUTH_saved01",
    customerCode: "CUS_payer01",
    email: "payer@example.com",
    signature: "SIG_card01",
  });
}

/** Move the schedule back to due, as the next cycle (or the same one, re-run). */
export function makeDue(over: Record<string, unknown> = {}) {
  const current = mem.read(`recurringInvoices/${SCHEDULE}`)!;
  mem.seed(`recurringInvoices/${SCHEDULE}`, {
    ...current,
    nextRunAt: Timestamp.fromDate(new Date("2026-02-28T22:00:00.000Z")),
    ...over,
  });
}

export type ChargeAnswer = { status?: number; body: unknown } | "network-error";

/** A charge_authorization envelope with the given charge status. */
export const chargeAnswer = (status: string, gateway = "Approved"): ChargeAnswer => ({
  body: { status: true, message: "Charge attempted", data: { status, reference: REF, gateway_response: gateway } },
});

/**
 * Paystack: `charge` answers `/transaction/charge_authorization`, verify
 * answers a success for `REF` at `AMOUNT` (override with `verify`).
 */
export function stubAutoCharge(opts: { charge?: () => ChargeAnswer; verify?: Record<string, unknown> } = {}) {
  return stubPaystack((call: PaystackCall) =>
    call.path === "/transaction/charge_authorization"
      ? (opts.charge ?? (() => chargeAnswer("success")))()
      : verified({ reference: REF, amount: AMOUNT, ...opts.verify }),
  );
}

export const chargeCalls = (calls: PaystackCall[]) =>
  calls.filter((c) => c.path === "/transaction/charge_authorization");

/** The invoice the cycle raised (the only `quotes` doc with the schedule id). */
export function raised(): Record<string, unknown> & { id: string } {
  const all = mem.list("quotes").filter((q) => q.recurringInvoiceId === SCHEDULE);
  return all[all.length - 1];
}
