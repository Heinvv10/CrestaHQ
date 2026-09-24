import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  KEY,
  OTHER_KEY,
  SA,
  mem,
  seedAttempt,
  seedInvoice,
  seedSub,
  stubPaystack,
  verified,
} from "@/test/paystack-links-harness";

/**
 * Seam test: a REAL card cycle leaves its charge pending or unknown; the REAL
 * sweep re-checks it through the same `recheckCardCharge` as the button, over
 * the in-memory Firestore and the Paystack `fetch` stub, and does what a
 * synchronous outcome in `chargeCycle` does — once, whoever races it.
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
const { reconcileAutoCharge } = await import("@/lib/paystack/auto-charge-reconciler");
const { recheckStaleAutoCharges, STALE_RECHECK_BATCH } = await import("./auto-charge-stale-sweep");

const HOUR = 60 * 60 * 1000;
/** Run the sweep `ms` after now (the attempt's createdAt is the real clock). */
const sweep = (ms: number) => recheckStaleAutoCharges(new Date(Date.now() + ms));
/** A card cycle whose charge call answered `status` (success → pending; send_otp → unknown). */
async function cycle(status = "success") {
  stubAutoCharge({ charge: () => chargeAnswer(status) });
  await runOneSchedule(SCHEDULE, NOW);
  expect(raised().autoCharge).toMatchObject({ state: status === "success" ? "pending" : "unknown" });
}
const verifyAnswers = (status: string) => stubPaystack(() => verified({ reference: REF, amount: AMOUNT, status }));
const verifies = (calls: { path: string }[]) => calls.filter((c) => c.path.startsWith("/transaction/verify"));
const triggers = (type: string) => fireWorkflowTrigger.mock.calls.filter(([i]) => i.type === type).length;
const attempt = () => mem.read(`paymentAttempts/${REF}`)!;
const declines = () => mem.read(`paymentMandates/${MANDATE}`)!.consecutiveDeclines;
const STALE_TITLE = "still unconfirmed after 3 days";

/** Paystack answers `status`; the FIRST call first lets `race` run to completion. */
function raceOnFirstCall(status: string, race: () => Promise<unknown>) {
  const calls = verifyAnswers(status);
  const inner = globalThis.fetch;
  let raced = false;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!raced) {
      raced = true;
      await race();
    }
    return inner(url, init);
  });
  return calls;
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

describe("Paystack now says the charge failed", () => {
  it("declines as a synchronous decline does, emails the invoice with a pay link, fires charge_failed once", async () => {
    await cycle("send_otp");
    expect(sendEmail).not.toHaveBeenCalled();
    verifyAnswers("failed");
    expect(await sweep(2 * HOUR)).toEqual({ checked: 1, paid: 0, declined: 1, alerted: 0 });
    expect(attempt().state).toBe("refused");
    expect(raised().autoCharge).toMatchObject({ reference: REF, state: "declined" });
    expect(declines()).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0]![0] as { text: string }).text).toContain("/pay/link/");
    expect(raised().status).toBe("sent");
    expect(triggers("invoice.charge_failed")).toBe(1);
  });

  it("a second sweep changes nothing: no second email, trigger or decline", async () => {
    await cycle("send_otp");
    verifyAnswers("failed");
    await sweep(2 * HOUR);
    const before = raised();
    expect(await sweep(3 * HOUR)).toEqual({ checked: 0, paid: 0, declined: 0, alerted: 0 });
    expect(raised()).toEqual(before);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(triggers("invoice.charge_failed")).toBe(1);
    expect(declines()).toBe(1);
  });

  it("the operator's button declining it mid-sweep: the sweep adds no email, trigger or decline", async () => {
    await cycle("send_otp");
    raceOnFirstCall("failed", () => recheckCardCharge(SA, raised().id));
    expect(await sweep(2 * HOUR)).toMatchObject({ checked: 1, declined: 0 });
    expect(raised().autoCharge).toMatchObject({ state: "declined" });
    expect(declines()).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(triggers("invoice.charge_failed")).toBe(0);
  });
});

describe("Paystack now says success", () => {
  it("records the invoice paid by the saved card; charge_succeeded once; nothing emailed", async () => {
    await cycle();
    stubAutoCharge();
    expect(await sweep(2 * HOUR)).toMatchObject({ checked: 1, paid: 1 });
    expect(raised()).toMatchObject({ status: "paid", paidVia: { rail: "paystack_auto", reference: REF } });
    expect(attempt().state).toBe("settled");
    expect(triggers("invoice.charge_succeeded")).toBe(1);
    expect(triggers("invoice.charge_failed")).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("the webhook settling it mid-sweep: nothing fired or sent twice", async () => {
    await cycle();
    raceOnFirstCall("success", () => reconcileAutoCharge({ subAccountId: SA, secretKey: KEY, reference: REF }));
    expect(await sweep(2 * HOUR)).toMatchObject({ checked: 1 });
    expect(raised()).toMatchObject({ status: "paid", paidVia: { rail: "paystack_auto" } });
    expect(triggers("invoice.charge_succeeded")).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("the webhook settling it between the query and the re-check: a no-op", async () => {
    await cycle();
    stubAutoCharge();
    // The sweep's first read after its query is the schedule: settle first.
    const doc = mem.db.doc.bind(mem.db);
    let raced = false;
    vi.spyOn(mem.db, "doc").mockImplementation((path: string) => {
      const ref = doc(path);
      if (raced || !path.startsWith("recurringInvoices/")) return ref;
      raced = true;
      const get = ref.get.bind(ref);
      return Object.assign(ref, {
        get: async () => {
          await reconcileAutoCharge({ subAccountId: SA, secretKey: KEY, reference: REF });
          return get();
        },
      });
    });
    expect(await sweep(2 * HOUR)).toMatchObject({ checked: 1, paid: 0 });
    expect(raced).toBe(true);
    expect(raised()).toMatchObject({ status: "paid", paidVia: { rail: "paystack_auto" } });
    expect(triggers("invoice.charge_succeeded")).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("left alone", () => {
  it("younger than an hour: Paystack not asked", async () => {
    await cycle("send_otp");
    const before = raised();
    const calls = verifyAnswers("failed");
    expect(await sweep(30 * 60 * 1000)).toEqual({ checked: 0, paid: 0, declined: 0, alerted: 0 });
    expect(verifies(calls)).toHaveLength(0);
    expect(raised()).toEqual(before);
    expect(attempt().state).toBe("open");
  });

  it("the Paystack key changed since the charge: skipped quietly, no Task, even after 3 days", async () => {
    await cycle();
    const tasks = mem.list("tasks").length;
    mem.seed(`subAccounts/${SA}/private/paystackConnection`, { secretKey: OTHER_KEY });
    const calls = verifyAnswers("failed");
    await sweep(73 * HOUR);
    expect(verifies(calls)).toHaveLength(0);
    expect(attempt().state).toBe("open");
    expect(raised().autoCharge).toMatchObject({ state: "pending" });
    expect(mem.list("tasks")).toHaveLength(tasks);
  });
});

describe("still no final answer", () => {
  it("before 3 days: no Task", async () => {
    await cycle();
    verifyAnswers("pending");
    expect(await sweep(71 * HOUR)).toMatchObject({ checked: 1, alerted: 0 });
    expect(tasksAbout(STALE_TITLE)).toHaveLength(0);
    expect(attempt().state).toBe("open");
  });

  it("after 3 days: exactly one Task across two runs, naming the invoice and reference", async () => {
    await cycle();
    verifyAnswers("pending");
    expect(await sweep(73 * HOUR)).toMatchObject({ alerted: 1 });
    expect(await sweep(97 * HOUR)).toMatchObject({ checked: 1, alerted: 0 });
    const tasks = tasksAbout(STALE_TITLE);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe(
      `Card charge for invoice INV-2026-0004 is still unconfirmed after 3 days: check Paystack (reference ${REF})`,
    );
    expect(attempt()).toMatchObject({ state: "open", staleAlertedAt: expect.any(Date) });
    expect(raised().autoCharge).toMatchObject({ state: "pending" });
  });

  it("no answer at all counts the same", async () => {
    await cycle();
    stubPaystack(() => "network-error");
    await sweep(73 * HOUR);
    expect(tasksAbout(STALE_TITLE)).toHaveLength(1);
  });

  it("a Task that fails to create releases the claim, so the next run raises it", async () => {
    await cycle();
    verifyAnswers("pending");
    failNextTasks(1);
    await sweep(73 * HOUR);
    expect(tasksAbout(STALE_TITLE)).toHaveLength(0);
    expect(attempt().staleAlertedAt).toBeUndefined();
    await sweep(74 * HOUR);
    expect(tasksAbout(STALE_TITLE)).toHaveLength(1);
  });
});

describe("the batch", () => {
  it(`re-checks at most ${STALE_RECHECK_BATCH} card charges a run, oldest first, and never a checkout`, async () => {
    const base = Date.now() - 2 * HOUR;
    seedAttempt("pl-link1-x1", { createdAt: new Date(base - 60 * HOUR) }); // a checkout: not queried
    seedAttempt("legacy1", { invoiceId: "inv1", createdAt: new Date(base - 61 * HOUR) }); // no card: in the batch, not re-checked
    for (let i = 1; i <= 30; i += 1) {
      const reference = `ra-${SCHEDULE}-c${i}`;
      seedInvoice(`inv${i}`, { autoCharge: { reference, mandateId: MANDATE, state: "pending", reason: null } });
      seedAttempt(reference, {
        mandateId: MANDATE,
        invoiceId: `inv${i}`,
        recurringInvoiceId: SCHEDULE,
        amountCents: AMOUNT,
        createdAt: new Date(base - i * 1000),
      });
    }
    const calls = verifyAnswers("pending");
    expect(await sweep(0)).toMatchObject({ checked: STALE_RECHECK_BATCH - 1 });
    const asked = verifies(calls).map((c) => c.path.split("/").pop());
    expect(asked).toHaveLength(STALE_RECHECK_BATCH - 1);
    expect(asked).not.toContain("pl-link1-x1");
    expect(asked).toContain(`ra-${SCHEDULE}-c30`);
    expect(asked).not.toContain(`ra-${SCHEDULE}-c5`);
  });

  it("one attempt's re-check throwing does not stop the next", async () => {
    await cycle("send_otp");
    seedInvoice("inv9", { autoCharge: { reference: "ra-other-c1", mandateId: MANDATE, state: "pending", reason: null } });
    seedAttempt("ra-other-c1", {
      mandateId: MANDATE,
      invoiceId: "inv9",
      recurringInvoiceId: SCHEDULE,
      createdAt: new Date(Date.now() - 5 * HOUR),
    });
    verifyAnswers("failed");
    // The older one (ra-other-c1) goes first and throws after its decline.
    fireWorkflowTrigger.mockRejectedValueOnce(new Error("engine down"));
    expect(await sweep(2 * HOUR)).toMatchObject({ checked: 2, declined: 1 });
    expect(raised().autoCharge).toMatchObject({ state: "declined" });
  });
});
