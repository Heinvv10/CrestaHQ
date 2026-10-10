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
 * PR #237 fix round 1 (the breaker's R1–R3 repros and the blind review's
 * MEDIUM), on the same seam as `auto-charge-stale-sweep.test.ts`: a REAL card
 * cycle, the REAL sweep and re-check, the in-memory Firestore and the
 * Paystack `fetch` stub. The route-level R4 lives in the cron route's test.
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
const { sendQuoteServerSide } = await import("@/lib/server/quote-send-service");
const { recheckStaleAutoCharges, STALE_RECHECK_BATCH } = await import("./auto-charge-stale-sweep");

const HOUR = 60 * 60 * 1000;
const sweep = (ms: number, budgetMs?: number) => recheckStaleAutoCharges(new Date(Date.now() + ms), budgetMs);
/** A card cycle whose charge got no clear answer (send_otp → unknown). */
async function cycle() {
  stubAutoCharge({ charge: () => chargeAnswer("send_otp") });
  await runOneSchedule(SCHEDULE, NOW);
  expect(raised().autoCharge).toMatchObject({ state: "unknown" });
}
const verifyAnswers = (status: string) => stubPaystack(() => verified({ reference: REF, amount: AMOUNT, status }));
const verifies = (calls: { path: string }[]) => calls.filter((c) => c.path.startsWith("/transaction/verify"));
const triggers = (type: string) => fireWorkflowTrigger.mock.calls.filter(([i]) => i.type === type).length;
const attempt = () => mem.read(`paymentAttempts/${REF}`)!;
const declines = () => mem.read(`paymentMandates/${MANDATE}`)!.consecutiveDeclines ?? 0;
const markPaid = async () =>
  expect((await markQuotePaidServerSide({ quoteId: raised().id, expectSubAccountId: SA })).ok).toBe(true);
/** An open card-cycle attempt whose invoice never got its `autoCharge` (the write failed, or the process died). */
function seedStuck(reference: string, invoiceId: string, createdAt: Date) {
  seedInvoice(invoiceId, {});
  seedAttempt(reference, { mandateId: MANDATE, invoiceId, recurringInvoiceId: SCHEDULE, amountCents: AMOUNT, createdAt });
}
const PAID_BY_HAND = "already marked paid by hand";
const UNCONFIRMABLE = "could not be confirmed automatically";

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

describe("R1: marked paid by hand while the charge was unconfirmed, then Paystack says it failed", () => {
  it("the invoice stays paid and unsent; the attempt closes; the card is not blamed; ONE Task", async () => {
    await cycle();
    await markPaid();
    verifyAnswers("failed");
    expect(await sweep(2 * HOUR)).toMatchObject({ checked: 1, declined: 0, alerted: 1 });
    expect(raised().status).toBe("paid");
    expect(raised().autoCharge).toMatchObject({
      state: "declined",
      reason: "failed at Paystack after the invoice was marked paid by hand",
    });
    expect(attempt().state).toBe("refused");
    expect(declines()).toBe(0);
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(triggers("invoice.charge_failed")).toBe(0);
    const tasks = tasksAbout(PAID_BY_HAND);
    expect(tasks.map((t) => t.title)).toEqual([
      `Card charge ${REF} for invoice INV-2026-0004 failed at Paystack, but the invoice was already marked paid by hand — confirm the payment you recorded.`,
    ]);
    await sweep(26 * HOUR);
    expect(tasksAbout(PAID_BY_HAND)).toHaveLength(1);
  });

  it("the breaker's R1b: a PayPal workspace's paid invoice is not emailed and flipped back to sent", async () => {
    await cycle();
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, paypalConfig: { username: "acmefibre" } });
    await markPaid();
    verifyAnswers("failed");
    await sweep(2 * HOUR);
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(raised().status).toBe("paid");
  });

  it("the button says so, and neither emails, fires nor raises anything", async () => {
    await cycle();
    await markPaid();
    const tasks = mem.list("tasks").length;
    verifyAnswers("failed");
    expect(await recheckCardCharge(SA, raised().id)).toEqual({ ok: true, outcome: "failed_but_paid" });
    expect(attempt().state).toBe("refused");
    expect(declines()).toBe(0);
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
    await flushAfterResponse();
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
    expect(mem.list("tasks")).toHaveLength(tasks);
  });

  it("the button closing it mid-sweep: the sweep raises no Task of its own", async () => {
    await cycle();
    await markPaid();
    const calls = verifyAnswers("failed");
    const inner = globalThis.fetch;
    let raced = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (!raced) {
        raced = true;
        expect(await recheckCardCharge(SA, raised().id)).toMatchObject({ outcome: "failed_but_paid" });
      }
      return inner(url, init);
    });
    expect(await sweep(2 * HOUR)).toMatchObject({ alerted: 0 });
    expect(verifies(calls)).toHaveLength(2);
    expect(tasksAbout(PAID_BY_HAND)).toHaveLength(0);
  });

  it("a paid invoice is never re-sent: sendQuoteServerSide refuses it and leaves it paid", async () => {
    await cycle();
    await markPaid();
    const res = await sendQuoteServerSide({ subAccountId: SA, quoteId: raised().id, actor: { kind: "system", reason: "test" } });
    expect(res).toMatchObject({ ok: false, failure: { code: "already_paid", status: 409, error: "This invoice is already paid." } });
    expect(raised().status).toBe("paid");
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("the blind review's MEDIUM: the follow-up after a decline throws", () => {
  it("before the email starts → a Task says to send it by hand; charge_failed still fires once", async () => {
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
    expect(await sweep(2 * HOUR)).toMatchObject({ declined: 1 });
    vi.mocked(mem.db.doc).mockRestore();
    expect(raised().autoCharge).toMatchObject({ state: "declined" });
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(tasksAbout("could not be emailed automatically").map((t) => t.title)).toEqual([
      "Card charge for invoice INV-2026-0004 was declined, but the invoice could not be emailed automatically: Firestore unavailable. Send it by hand.",
    ]);
    expect(triggers("invoice.charge_failed")).toBe(1);
  });

  it("the email step throwing → ONE Task (the send path's own), not a second", async () => {
    await cycle();
    const before = mem.list("tasks").length;
    let armed = false;
    stubPaystack(() => {
      armed = true;
      return verified({ reference: REF, amount: AMOUNT, status: "failed" });
    });
    const doc = mem.db.doc.bind(mem.db);
    vi.spyOn(mem.db, "doc").mockImplementation((path: string) => {
      const ref = doc(path);
      if (!armed || path !== `subAccounts/${SA}`) return ref;
      return Object.assign(ref, { get: async () => Promise.reject(new Error("Firestore unavailable")) });
    });
    await sweep(2 * HOUR);
    vi.mocked(mem.db.doc).mockRestore();
    const added = mem.list("tasks").slice(before);
    expect(added.map((t) => t.title)).toEqual(["Invoice INV-2026-0004 was not sent: the send failed unexpectedly"]);
    expect(triggers("invoice.charge_failed")).toBe(1);
  });

  it("the send itself failing → ONE Task, from the send path, as a synchronous decline", async () => {
    await cycle();
    const before = mem.list("tasks").length;
    sendEmail.mockRejectedValue(new Error("smtp down"));
    verifyAnswers("failed");
    await sweep(2 * HOUR);
    const added = mem.list("tasks").slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.title).toContain("was not sent");
    expect(triggers("invoice.charge_failed")).toBe(1);
  });
});

describe("R2/R3: attempts the re-check can never resolve", () => {
  it("R2: a full batch of them does not starve a fresh failed charge", async () => {
    for (let i = 1; i <= STALE_RECHECK_BATCH; i += 1) {
      seedStuck(`ra-${SCHEDULE}-c${100 + i}`, `stuck${i}`, new Date(Date.now() - 10 * HOUR - i * 1000));
    }
    await cycle();
    const calls = verifyAnswers("failed");
    expect(await sweep(2 * HOUR)).toMatchObject({ checked: 1, declined: 1 });
    expect(raised().autoCharge).toMatchObject({ state: "declined" });
    expect(verifies(calls).map((c) => c.path.split("/").pop())).toEqual([REF]);
  });

  it("R3: after 3 days one is flagged (leaving the open query) and ONE Task names it", async () => {
    const ref = `ra-${SCHEDULE}-c9`;
    seedStuck(ref, "inv-crash", new Date(Date.now() - 2 * HOUR));
    verifyAnswers("pending");
    await sweep(60 * HOUR);
    expect(tasksAbout(ref)).toHaveLength(0);
    expect(mem.read(`paymentAttempts/${ref}`)!.state).toBe("open");
    expect(await sweep(80 * HOUR)).toMatchObject({ checked: 0, alerted: 1 });
    await sweep(104 * HOUR);
    expect(tasksAbout(ref).map((t) => t.title)).toEqual([
      `Card charge ${ref} (invoice INV-2026-0001) ${UNCONFIRMABLE} — the card may have been charged. Check Paystack.`,
    ]);
    expect(mem.read(`paymentAttempts/${ref}`)).toMatchObject({ state: "flagged", staleAlertedAt: expect.any(Date) });
  });

  it("its schedule gone: the same flag and Task", async () => {
    await cycle();
    await mem.db.doc(`recurringInvoices/${SCHEDULE}`).delete();
    const calls = verifyAnswers("failed");
    await sweep(73 * HOUR);
    expect(verifies(calls)).toHaveLength(0);
    expect(attempt().state).toBe("flagged");
    expect(tasksAbout(UNCONFIRMABLE)).toHaveLength(1);
  });

  it("a Task that fails to create reopens the attempt, so the next run raises it", async () => {
    const ref = `ra-${SCHEDULE}-c9`;
    seedStuck(ref, "inv-crash", new Date(Date.now() - 2 * HOUR));
    failNextTasks(3); // every inline try
    await sweep(80 * HOUR);
    expect(mem.read(`paymentAttempts/${ref}`)!.state).toBe("open");
    await sweep(81 * HOUR);
    expect(tasksAbout(ref)).toHaveLength(1);
    expect(mem.read(`paymentAttempts/${ref}`)!.state).toBe("flagged");
  });
});

describe("R4: the time budget", () => {
  it("stops starting re-checks once spent, and says how many it skipped", async () => {
    await cycle();
    const calls = verifyAnswers("failed");
    expect(await sweep(2 * HOUR, 0)).toMatchObject({ checked: 0, overBudget: 1 });
    expect(verifies(calls)).toHaveLength(0);
    expect(attempt().state).toBe("open");
  });
});
