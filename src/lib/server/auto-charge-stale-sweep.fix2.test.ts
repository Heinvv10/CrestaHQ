import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

import {
  AMOUNT,
  MANDATE,
  NOW,
  REF,
  SCHEDULE,
  chargeAnswer,
  failNextTasks,
  raised,
  seedCardSchedule,
  seedMandate,
  stubAutoCharge,
  tasksAbout,
} from "@/test/auto-charge-harness";
import { SA, mem, seedAttempt, seedInvoice, seedSub, stubPaystack, verified } from "@/test/paystack-links-harness";

/**
 * PR #237 fix round 2 (the breaker's R5–R8), on the same seam as
 * `auto-charge-stale-sweep.test.ts`: a REAL card cycle, the REAL sweep and
 * re-check, the in-memory Firestore and the Paystack `fetch` stub. R9 lives
 * in the cron route's test.
 */

const fireWorkflowTrigger = vi.fn();
const sendEmail = vi.fn();
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/quotes/number", () => ({ issueQuoteNumber: async () => "INV-2026-0004" }));
vi.mock("@/lib/server/tasks-service", async () => (await import("@/test/auto-charge-harness")).tasksMock());
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: (...a: unknown[]) => fireWorkflowTrigger(...a) }));
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

const { runOneSchedule } = await import("@/lib/server/recurring-invoice-service");
const { recheckCardCharge } = await import("@/lib/server/auto-charge-recheck");
const { markQuotePaidServerSide } = await import("@/lib/server/quotes-service");
const { recheckStaleAutoCharges } = await import("./auto-charge-stale-sweep");

const HOUR = 60 * 60 * 1000;
const sweep = (ms: number, budgetMs?: number) => recheckStaleAutoCharges(new Date(Date.now() + ms), budgetMs);
/** A card cycle whose charge got no clear answer (send_otp → unknown). */
async function cycle() {
  stubAutoCharge({ charge: () => chargeAnswer("send_otp") });
  await runOneSchedule(SCHEDULE, NOW);
  expect(raised().autoCharge).toMatchObject({ state: "unknown" });
}
const verifyAnswers = (status: string) => stubPaystack(() => verified({ reference: REF, amount: AMOUNT, status }));
const attempt = () => mem.read(`paymentAttempts/${REF}`)!;
const declines = () => mem.read(`paymentMandates/${MANDATE}`)!.consecutiveDeclines ?? 0;
const markPaid = async () =>
  expect((await markQuotePaidServerSide({ quoteId: raised().id, expectSubAccountId: SA })).ok).toBe(true);
const PAID_BY_HAND = "already marked paid by hand";
const STALE_TITLE = "still unconfirmed after 3 days";
/** `n` open card-cycle attempts `ageMs` old; `withCharge`: their invoices carry a pending `autoCharge`. */
function seedMany(n: number, prefix: string, ageMs: number, withCharge: boolean) {
  for (let i = 1; i <= n; i += 1) {
    const reference = `ra-${prefix}-c${i}`;
    seedInvoice(`${prefix}${i}`, withCharge ? { autoCharge: { reference, mandateId: MANDATE, state: "pending", reason: null } } : {});
    seedAttempt(reference, {
      mandateId: MANDATE,
      invoiceId: `${prefix}${i}`,
      recurringInvoiceId: SCHEDULE,
      amountCents: AMOUNT,
      createdAt: new Date(Date.now() - ageMs - i * 1000),
    });
  }
}

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  failNextTasks(0);
  sendEmail.mockResolvedValue(undefined);
  fireWorkflowTrigger.mockResolvedValue({ enrolled: [], skipped: [], reason: null });
  seedSub();
  seedCardSchedule();
  seedMandate();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("R5: a charge with no final answer after 3 days leaves the sweep", () => {
  it("the breaker's repro: 25 of one tenant's charges Paystack answers 401 for no longer starve a newer charge", async () => {
    seedMany(25, "revoked", 10 * HOUR, true);
    await cycle();
    stubPaystack((c) =>
      c.path.includes("ra-revoked")
        ? { status: 401, body: { status: false, message: "Invalid key" } }
        : verified({ reference: REF, amount: AMOUNT, status: "failed" }),
    );
    for (let d = 1; d <= 5; d += 1) await sweep(d * 24 * HOUR);
    expect(raised().autoCharge).toMatchObject({ state: "declined" });
    expect(mem.read("paymentAttempts/ra-revoked-c1")!.state).toBe("flagged");
  });

  it("flagged with a reason in the claim; ONE Task that points at the button", async () => {
    await cycle();
    verifyAnswers("pending");
    expect(await sweep(73 * HOUR)).toMatchObject({ alerted: 1 });
    expect(attempt()).toMatchObject({ state: "flagged", reason: expect.stringContaining("Re-check card charge") });
    const [task, ...more] = tasksAbout(STALE_TITLE);
    expect(more).toHaveLength(0);
    expect(task!.notes).toContain('use "Re-check card charge"');
  });

  it("the button still declines it once Paystack says it failed", async () => {
    await cycle();
    verifyAnswers("pending");
    await sweep(73 * HOUR);
    verifyAnswers("failed");
    expect(await recheckCardCharge(SA, raised().id)).toEqual({ ok: true, outcome: "declined" });
    expect(attempt().state).toBe("refused");
    expect(raised().autoCharge).toMatchObject({ state: "declined" });
    expect(declines()).toBe(1);
  });

  it("the button still records it paid once Paystack says success", async () => {
    await cycle();
    verifyAnswers("pending");
    await sweep(73 * HOUR);
    stubAutoCharge();
    expect(await recheckCardCharge(SA, raised().id)).toEqual({ ok: true, outcome: "paid" });
    expect(attempt().state).toBe("settled");
    expect(raised()).toMatchObject({ status: "paid", paidVia: { rail: "paystack_auto" } });
  });

  it("an attempt flagged for another reason (money may have arrived) is never declined by the button", async () => {
    await cycle();
    mem.seed(`paymentAttempts/${REF}`, { ...attempt(), state: "flagged", reason: "Paystack reported a charge under a different key" });
    verifyAnswers("failed");
    expect(await recheckCardCharge(SA, raised().id)).toMatchObject({ ok: false, status: 409 });
    expect(attempt().state).toBe("flagged");
    expect(raised().autoCharge).toMatchObject({ state: "unknown" });
    expect(declines()).toBe(0);
  });
});

describe("R6: a Task whose attempt is already closed", () => {
  it("the breaker's repro: one failed creation is retried inline", async () => {
    await cycle();
    await markPaid();
    verifyAnswers("failed");
    failNextTasks(1);
    await sweep(2 * HOUR);
    await sweep(26 * HOUR);
    expect(tasksAbout(PAID_BY_HAND)).toHaveLength(1);
  });

  it("three failed tries: logged with the invoice and reference, and written to the attempt's reason", async () => {
    await cycle();
    await markPaid();
    verifyAnswers("failed");
    failNextTasks(3);
    await sweep(2 * HOUR);
    expect(tasksAbout(PAID_BY_HAND)).toHaveLength(0);
    expect(attempt()).toMatchObject({ state: "refused", reason: expect.stringContaining(PAID_BY_HAND) });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`ref=${REF} invoice=INV-2026-0004 Task not raised after 3 tries`)),
      expect.any(Error),
    );
  });

  it("the same for the decline follow-up's Task", async () => {
    await cycle();
    let armed = false;
    stubPaystack(() => {
      armed = true;
      return verified({ reference: REF, amount: AMOUNT, status: "failed" });
    });
    const doc = mem.db.doc.bind(mem.db);
    vi.spyOn(mem.db, "doc").mockImplementation((path: string) => {
      const ref = doc(path);
      if (!armed || !path.startsWith("quotes/")) return ref;
      return Object.assign(ref, { get: async () => Promise.reject(new Error("Firestore unavailable")) });
    });
    failNextTasks(3);
    await sweep(2 * HOUR);
    vi.mocked(mem.db.doc).mockRestore();
    expect(attempt().reason).toContain("could not be emailed automatically");
  });
});

describe("R7: failed but already paid", () => {
  it("the charge is marked declined, so the paid invoice offers no re-check; a second click changes nothing", async () => {
    await cycle();
    await markPaid();
    verifyAnswers("failed");
    await sweep(2 * HOUR);
    expect(raised().autoCharge).toMatchObject({ state: "declined", reason: "failed at Paystack after the invoice was marked paid by hand" });
    const before = raised();
    expect(await recheckCardCharge(SA, raised().id)).toMatchObject({ ok: false, status: 409 });
    expect(raised()).toEqual(before);
    expect(declines()).toBe(0);
    expect(tasksAbout(PAID_BY_HAND)).toHaveLength(1);
  });
});

describe("R8: the paid guard's race", () => {
  it("the breaker's repro: an invoice marked paid while its email was going out stays paid", async () => {
    await cycle();
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, paypalConfig: { username: "acmefibre" } });
    verifyAnswers("failed");
    sendEmail.mockImplementationOnce(async () => {
      await markPaid();
    });
    await sweep(2 * HOUR);
    await flushAfterResponse();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(raised().status).toBe("paid");
  });
});
