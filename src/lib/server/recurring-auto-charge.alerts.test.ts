import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MANDATE,
  NOW,
  REF,
  SCHEDULE,
  chargeAnswer,
  chargeCalls,
  makeDue,
  seedCardSchedule,
  seedMandate,
  stubAutoCharge,
  tasksAbout,
} from "@/test/auto-charge-harness";
import { SA, mem, refused, seedSub } from "@/test/paystack-links-harness";

/**
 * Fix round 1 (PR #220): what needs a human becomes a Task, never only
 * `schedule.lastError` (the next claim clears it); a non-success, non-failed
 * charge status is an unknown outcome, not a payment in flight; Paystack
 * refusing OUR key is not the card's decline; and moving a card schedule's
 * anchor can never pull its next charge forward.
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
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async (_req: Request, subAccountId: string) =>
    subAccountId === "sa1" ? { uid: "u1", agencyId: "ag1" } : NextResponse.json({}, { status: 403 }),
}));

const { runOneSchedule } = await import("./recurring-invoice-service");
const { PATCH } = await import("@/app/api/sub-accounts/[id]/recurring-invoices/[recurringId]/route");

const schedule = () => mem.read(`recurringInvoices/${SCHEDULE}`)!;
const mandate = () => mem.read(`paymentMandates/${MANDATE}`)!;
const emailed = () => sendQuoteServerSide.mock.calls.length;

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  seedSub();
  seedCardSchedule();
  seedMandate();
  sendQuoteServerSide.mockResolvedValue({ ok: true });
  fireWorkflowTrigger.mockResolvedValue({ enrolled: [], skipped: [], reason: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
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
      makeDue();
      await runOneSchedule(SCHEDULE, NOW);
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
    expect(fireWorkflowTrigger.mock.calls.filter(([i]) => i.type === "invoice.charge_failed")).toHaveLength(1);
  });

  it("a 402 card refusal is still a decline", async () => {
    stubAutoCharge({ charge: () => refused(402, "Insufficient funds") });
    await runOneSchedule(SCHEDULE, NOW);
    expect(mandate()).toMatchObject({ consecutiveDeclines: 1 });
  });
});

describe("moving a card schedule's billing day", () => {
  function patch(body: Record<string, unknown>) {
    return PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: SA, recurringId: SCHEDULE }) },
    );
  }

  it("charged 1 Mar, anchor moved to the 5th on 2 Mar, run 5 Mar → one charge", async () => {
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, NOW);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T08:00:00Z"));
    expect((await patch({ anchorDay: 5 })).status).toBe(200);
    vi.useRealTimers();
    await runOneSchedule(SCHEDULE, new Date("2026-03-05T05:00:00Z"));
    expect(chargeCalls(calls).map((c) => c.body!.reference)).toEqual([REF]);
  });

  it("switching to card in the same edit also restarts from the next run", async () => {
    stubAutoCharge();
    seedCardSchedule({ chargeMode: "invoice" });
    await runOneSchedule(SCHEDULE, NOW);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T08:00:00Z"));
    expect((await patch({ chargeMode: "card", anchorDay: 5 })).status).toBe(200);
    vi.useRealTimers();
    const next = (schedule().nextRunAt as { toDate: () => Date }).toDate();
    expect(next.toISOString()).toBe("2026-04-04T22:00:00.000Z");
  });

  it("an invoice schedule still moves from today", async () => {
    stubAutoCharge();
    seedCardSchedule({ chargeMode: "invoice" });
    await runOneSchedule(SCHEDULE, NOW);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T08:00:00Z"));
    await patch({ anchorDay: 5 });
    vi.useRealTimers();
    const next = (schedule().nextRunAt as { toDate: () => Date }).toDate();
    expect(next.toISOString()).toBe("2026-03-04T22:00:00.000Z");
  });
});
