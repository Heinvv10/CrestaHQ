import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MANDATE,
  NEXT,
  NOW,
  REF,
  SCHEDULE,
  chargeAnswer,
  makeDue,
  seedCardSchedule,
  seedMandate,
  failNextTasks,
  stubAutoCharge,
  tasksAbout,
} from "@/test/auto-charge-harness";
import { SA, mem, refused, seedSub } from "@/test/paystack-links-harness";

/**
 * Fix round 1 (PR #220): what needs a human becomes a Task, never only
 * `schedule.lastError` (the next claim clears it); a non-success, non-failed
 * charge status is an unknown outcome, not a payment in flight; Paystack
 * refusing OUR key is not the card's decline (and fires no charge_failed).
 * Edits that move a card schedule's run: see recurring-auto-charge.gap.test.ts.
 */

const sendQuoteServerSide = vi.fn();
const fireWorkflowTrigger = vi.fn();

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/quotes/number", () => ({ issueQuoteNumber: async () => "INV-2026-0004" }));
vi.mock("@/lib/server/tasks-service", async () => (await import("@/test/auto-charge-harness")).tasksMock());
vi.mock("@/lib/server/quote-send-service", () => ({
  sendQuoteServerSide: (...a: unknown[]) => sendQuoteServerSide(...a),
}));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: (...a: unknown[]) => fireWorkflowTrigger(...a),
}));

const { runOneSchedule } = await import("./recurring-invoice-service");

const schedule = () => mem.read(`recurringInvoices/${SCHEDULE}`)!;
const mandate = () => mem.read(`paymentMandates/${MANDATE}`)!;
const emailed = () => sendQuoteServerSide.mock.calls.length;

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  seedSub();
  seedCardSchedule();
  seedMandate();
  failNextTasks(0);
  sendQuoteServerSide.mockResolvedValue({ ok: true });
  fireWorkflowTrigger.mockResolvedValue({ enrolled: [], skipped: [], reason: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a charge status that is neither success nor failed", () => {
  it.each(["pending", "send_otp", "open_url", "ongoing"])(
    "%s: attempt open, not emailed, and a Task outlives the next cycle",
    async (status) => {
      stubAutoCharge({ charge: () => chargeAnswer(status) });
      await runOneSchedule(SCHEDULE, NOW);
      expect(mem.read(`paymentAttempts/${REF}`)).toMatchObject({ state: "open" });
      expect(emailed()).toBe(0);
      expect(tasksAbout(REF)).toHaveLength(1);

      stubAutoCharge();
      await runOneSchedule(SCHEDULE, NEXT);
      // The claim cleared lastError; the Task is still there.
      expect(schedule().lastError).toBeNull();
      expect(tasksAbout(REF)).toHaveLength(1);
      expect(tasksAbout(REF)[0].completed).toBe(false);
    },
  );
});

describe("an unknown outcome raises one Task", () => {
  it("names the reference and the invoice, and says to check Paystack before sending", async () => {
    stubAutoCharge({ charge: () => "network-error" });
    await runOneSchedule(SCHEDULE, NOW);
    const [task] = tasksAbout(REF);
    expect(`${task.title} ${task.notes}`).toContain("INV-2026-0004");
    expect(task.notes).toContain("check Paystack before sending this invoice — the card may already have been charged");
    expect(task).toMatchObject({ subAccountId: SA, contactId: "c1", createdByUid: "u1" });
    // Re-running the cycle charges nothing and raises nothing more.
    makeDue({ cyclesGenerated: 3 });
    await runOneSchedule(SCHEDULE, NOW);
    expect(tasksAbout(REF)).toHaveLength(1);
  });

  it("a Task that fails to create is logged; the cycle still completes and lastError still names the reference", async () => {
    stubAutoCharge({ charge: () => "network-error" });
    failNextTasks(1);
    expect(await runOneSchedule(SCHEDULE, NOW)).toMatchObject({ kind: "generated", sent: false });
    expect(tasksAbout(REF)).toHaveLength(0);
    expect(schedule().lastError).toContain(REF);
  });

  it("a successful charge raises no Task", async () => {
    stubAutoCharge();
    await runOneSchedule(SCHEDULE, NOW);
    expect(mem.list("tasks")).toHaveLength(0);
  });
});

describe("Paystack refusing the workspace's key", () => {
  it.each([401, 403])("%s: emailed, told, a Task — but no decline is counted", async (status) => {
    stubAutoCharge({ charge: () => refused(status, "Invalid key") });
    await runOneSchedule(SCHEDULE, NOW);
    expect(emailed()).toBe(1);
    expect(schedule().lastError).toMatch(/refused/i);
    expect(tasksAbout(REF)).toHaveLength(1);
    expect(mandate()).toMatchObject({ status: "active" });
    expect(mandate().consecutiveDeclines).toBeUndefined();
    expect(mem.read(`paymentAttempts/${REF}`)).toMatchObject({ state: "refused" });
    // N4: the customer's card did not fail — the workspace's key did.
    expect(fireWorkflowTrigger.mock.calls.filter(([i]) => i.type === "invoice.charge_failed")).toHaveLength(0);
  });

  it("a 402 card refusal is still a decline", async () => {
    stubAutoCharge({ charge: () => refused(402, "Insufficient funds") });
    await runOneSchedule(SCHEDULE, NOW);
    expect(mandate()).toMatchObject({ consecutiveDeclines: 1 });
  });
});
