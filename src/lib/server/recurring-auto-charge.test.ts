import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

import {
  AMOUNT,
  MANDATE,
  NEXT,
  NOW,
  REF,
  SCHEDULE,
  chargeAnswer,
  chargeCalls,
  makeDue,
  raised,
  seedCardSchedule,
  seedMandate,
  stubAutoCharge,
} from "@/test/auto-charge-harness";
import { KEY, OTHER_KEY, SA, mem, refused, seedInvoice, seedSub } from "@/test/paystack-links-harness";
import type { RecurringInvoiceDoc } from "@/types/recurring-invoices";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";

/**
 * Seam test: the REAL `runOneSchedule` for a `chargeMode: "card"` schedule,
 * over an in-memory Firestore with Paystack stubbed at `fetch`. The cycle
 * charges the saved card once per cycle, marks nothing paid from Paystack's
 * answer, and when the card cannot be charged — or is declined — emails the
 * invoice and says why. When the outcome is unknown it must NOT email.
 */

const sendQuoteServerSide = vi.fn();
const fireWorkflowTrigger = vi.fn();

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/quotes/number", () => ({ issueQuoteNumber: async () => "INV-2026-0004" }));
vi.mock("@/lib/server/tasks-service", () => ({
  createTaskServerSide: vi.fn(async () => ({ id: "task1" })),
  territoryForContact: async () => null,
}));
vi.mock("@/lib/server/quote-send-service", () => ({
  sendQuoteServerSide: (...a: unknown[]) => sendQuoteServerSide(...a),
}));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: (...a: unknown[]) => fireWorkflowTrigger(...a),
}));

const { runOneSchedule } = await import("./recurring-invoice-service");
const { chargeCycle } = await import("./recurring-auto-charge");

const schedule = () => mem.read(`recurringInvoices/${SCHEDULE}`)!;
const mandate = () => mem.read(`paymentMandates/${MANDATE}`)!;
const attempts = () => mem.list("paymentAttempts");
const emailed = () => sendQuoteServerSide.mock.calls.length;
const triggers = (type: string) => fireWorkflowTrigger.mock.calls.filter(([i]) => i.type === type);

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  seedSub();
  seedCardSchedule();
  seedMandate();
  // The real send flips the invoice to sent; the arrears count reads that.
  sendQuoteServerSide.mockImplementation(async ({ quoteId }: { quoteId: string }) => {
    mem.seed(`quotes/${quoteId}`, { ...mem.read(`quotes/${quoteId}`)!, status: "sent" });
    return { ok: true };
  });
  fireWorkflowTrigger.mockResolvedValue({ enrolled: [], skipped: [], reason: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("invoice mode is unchanged", () => {
  it("an invoice schedule emails and never calls Paystack", async () => {
    seedCardSchedule({ chargeMode: undefined });
    const calls = stubAutoCharge();
    expect(await runOneSchedule(SCHEDULE, NOW)).toMatchObject({ kind: "generated", sent: true });
    expect(calls).toHaveLength(0);
    expect(emailed()).toBe(1);
    expect(attempts()).toHaveLength(0);
  });

  it("a review-first schedule is never charged, whatever its mode says", async () => {
    seedCardSchedule({ reviewFirst: true });
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, NOW);
    expect(calls).toHaveLength(0);
    expect(emailed()).toBe(0);
  });
});

describe("a card cycle", () => {
  it("charges once, under the cycle's reference, and marks nothing paid from the answer", async () => {
    const calls = stubAutoCharge();
    expect(await runOneSchedule(SCHEDULE, NOW)).toMatchObject({ kind: "generated", sent: false });

    const charged = chargeCalls(calls);
    expect(charged).toHaveLength(1);
    expect(charged[0].auth).toBe(`Bearer ${KEY}`);
    expect(charged[0].body).toEqual({
      authorization_code: "AUTH_saved01",
      email: "payer@example.com",
      amount: AMOUNT,
      currency: "ZAR",
      reference: REF,
    });
    expect(mem.read(`paymentAttempts/${REF}`)).toMatchObject({
      subAccountId: SA,
      createdByUid: "u1",
      paymentLinkId: null,
      mandateId: MANDATE,
      invoiceId: raised().id,
      recurringInvoiceId: SCHEDULE,
      amountCents: AMOUNT,
      currency: "ZAR",
      mode: "test",
      keyFingerprint: paystackKeyFingerprint(KEY),
      state: "open",
    });
    const invoice = raised();
    expect(invoice.status).toBe("draft");
    expect(invoice.paidVia).toBeUndefined();
    expect(invoice.autoCharge).toEqual({ reference: REF, mandateId: MANDATE, state: "pending", reason: null });
    expect(emailed()).toBe(0);
    await flushAfterResponse();
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
    expect(schedule().lastError).toBeNull();
  });

  it("a re-run of the same cycle finds its attempt and charges nothing more", async () => {
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, NOW);
    makeDue({ cyclesGenerated: 3 });
    await runOneSchedule(SCHEDULE, NOW);
    expect(chargeCalls(calls)).toHaveLength(1);
    expect(emailed()).toBe(0);
    expect(schedule().lastError).toMatch(/already charged.*ra-sch1-c4/);
  });

  it("the next cycle charges under the next reference", async () => {
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, NOW);
    await runOneSchedule(SCHEDULE, NEXT);
    expect(chargeCalls(calls).map((c) => c.body!.reference)).toEqual([REF, `ra-${SCHEDULE}-c5`]);
  });
});

describe("a declined card", () => {
  it("emails the invoice, records the reason everywhere, fires charge_failed once", async () => {
    stubAutoCharge({ charge: () => chargeAnswer("failed", "Insufficient Funds") });
    expect(await runOneSchedule(SCHEDULE, NOW)).toMatchObject({ kind: "generated", sent: true });

    expect(emailed()).toBe(1);
    expect(mem.read(`paymentAttempts/${REF}`)).toMatchObject({ state: "refused", reason: expect.stringMatching(/Insufficient Funds/) });
    expect(raised().autoCharge).toEqual({ reference: REF, mandateId: MANDATE, state: "declined", reason: "Insufficient Funds" });
    expect(mandate()).toMatchObject({ status: "active", consecutiveDeclines: 1, lastDeclineReason: "Insufficient Funds" });
    expect(schedule().lastError).toMatch(/declined.*Insufficient Funds/);
    expect(triggers("invoice.charge_failed")).toEqual([
      [{ agencyId: "ag1", subAccountId: SA, type: "invoice.charge_failed", contactId: "c1" }],
    ]);
    await flushAfterResponse();
    expect(fireWorkflowTrigger).toHaveBeenCalledTimes(1);
  });

  it("a 4xx refusal from Paystack is a decline too", async () => {
    stubAutoCharge({ charge: () => refused(400, "Authorization is not reusable") });
    await runOneSchedule(SCHEDULE, NOW);
    expect(emailed()).toBe(1);
    expect(mem.read(`paymentAttempts/${REF}`)).toMatchObject({ state: "refused" });
    expect(triggers("invoice.charge_failed")).toHaveLength(1);
  });

  it("at the schedule's threshold the card needs attention, and the next cycle emails without charging", async () => {
    seedMandate({ consecutiveDeclines: 1 });
    const calls = stubAutoCharge({ charge: () => chargeAnswer("failed", "Do Not Honour") });
    await runOneSchedule(SCHEDULE, NOW);
    expect(mandate()).toMatchObject({ status: "attention", consecutiveDeclines: 2, attention: expect.stringMatching(/2 times/) });

    makeDue();
    await runOneSchedule(SCHEDULE, NOW);
    expect(chargeCalls(calls)).toHaveLength(1);
    expect(emailed()).toBe(2);
    expect(schedule().lastError).toMatch(/Card not charged.*needs attention/);
  });

  it("a threshold of 0 never puts the card in attention", async () => {
    seedCardSchedule({ unpaidEscalationThreshold: 0 });
    stubAutoCharge({ charge: () => chargeAnswer("failed", "Do Not Honour") });
    await runOneSchedule(SCHEDULE, NOW);
    expect(mandate()).toMatchObject({ status: "active", consecutiveDeclines: 1 });
  });

  it("below the threshold the card stays active", async () => {
    seedCardSchedule({ unpaidEscalationThreshold: 3 });
    seedMandate({ consecutiveDeclines: 1 });
    stubAutoCharge({ charge: () => chargeAnswer("failed", "Do Not Honour") });
    await runOneSchedule(SCHEDULE, NOW);
    expect(mandate()).toMatchObject({ status: "active", consecutiveDeclines: 2 });
  });
});

describe("a card that cannot be charged: the invoice is emailed and the operator told", () => {
  const cases: Array<[string, () => unknown, RegExp]> = [
    ["no saved card", () => seedCardSchedule({ cardMandateId: null }), /no card is saved/],
    ["a revoked card", () => seedMandate({ status: "revoked" }), /removed/],
    ["a card needing attention", () => seedMandate({ status: "attention", attention: "Key changed." }), /needs attention \(Key changed\.\)/],
    ["a key other than the card's", () => seedSub(SA, OTHER_KEY), /key changed/],
    ["Paystack disconnected", () => mem.seed(`subAccounts/${SA}/private/paystackConnection`, {}), /not connected/],
    ["a missing authorization", () => mem.db.doc(`paymentMandates/${MANDATE}/private/authorization`).delete(), /authorization is missing/],
    ["another schedule's card", () => seedMandate({ recurringInvoiceId: "sch_other" }), /could not be found/],
    ["another sub-account's card", () => seedMandate({ subAccountId: "sa2" }), /could not be found/],
    [
      "an amount changed since the customer agreed",
      () => seedCardSchedule({ lineItems: [{ id: "li1", description: "Fibre", quantity: 1, unitPrice: 1200 }] }),
      /no longer matches/,
    ],
    ["a cadence changed since the customer agreed", () => seedCardSchedule({ cadence: { unit: "week", interval: 1 }, anchorDay: null }), /no longer matches/],
  ];
  it.each(cases)("%s", async (_name, arrange, why) => {
    await arrange();
    const calls = stubAutoCharge();
    expect(await runOneSchedule(SCHEDULE, NOW)).toMatchObject({ kind: "generated", sent: true });
    expect(chargeCalls(calls)).toHaveLength(0);
    expect(attempts()).toHaveLength(0);
    expect(emailed()).toBe(1);
    expect(schedule().lastError).toMatch(/^Card not charged for invoice INV-2026-0004: /);
    expect(schedule().lastError).toMatch(why);
  });
});

describe("an invoice that no longer matches the card's terms", () => {
  // The cycle mints the invoice from the schedule, so only an edit between
  // minting and charging makes them differ — driven through chargeCycle.
  it.each([
    ["another amount", { lineItems: [{ id: "li1", description: "Fibre", quantity: 1, unitPrice: 1200 }] }],
    ["another currency", { currency: "USD" }],
  ])("%s: not charged, emailed", async (_n, over) => {
    seedInvoice("inv9", { status: "draft", recurringInvoiceId: SCHEDULE, ...over });
    const calls = stubAutoCharge();
    const sched = { ...schedule(), id: SCHEDULE } as unknown as RecurringInvoiceDoc;
    expect(await chargeCycle(sched, "inv9", 4, NOW)).toBe(true);
    expect(chargeCalls(calls)).toHaveLength(0);
    expect(schedule().lastError).toMatch(/no longer matches/);
  });
});

describe("no clear answer from Paystack", () => {
  const cases: Array<[string, () => ReturnType<typeof chargeAnswer>]> = [
    ["a network error", () => "network-error"],
    ["a 5xx", () => refused(500, "Internal error")],
    ["a 429", () => refused(429, "Too many requests")],
    ["a duplicate-reference refusal", () => refused(400, "Duplicate Transaction Reference")],
  ];
  it.each(cases)("%s: the attempt stays open, nothing is emailed, the schedule names the reference", async (_n, charge) => {
    stubAutoCharge({ charge });
    expect(await runOneSchedule(SCHEDULE, NOW)).toMatchObject({ kind: "generated", sent: false });
    expect(mem.read(`paymentAttempts/${REF}`)).toMatchObject({ state: "open" });
    expect(emailed()).toBe(0);
    expect(raised().autoCharge).toMatchObject({ state: "unknown" });
    expect(schedule().lastError).toContain(REF);
    expect(mandate().consecutiveDeclines).toBeUndefined();
    await flushAfterResponse();
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
  });
});

describe("arrears", () => {
  it("still settle after a card cycle: a declined, emailed invoice counts as outstanding next cycle", async () => {
    stubAutoCharge({ charge: () => chargeAnswer("failed", "Declined") });
    await runOneSchedule(SCHEDULE, NOW);
    makeDue();
    await runOneSchedule(SCHEDULE, NOW);
    expect(schedule().outstandingInvoices).toBe(1);
  });
});
