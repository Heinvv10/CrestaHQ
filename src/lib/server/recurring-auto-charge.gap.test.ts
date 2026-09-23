import { Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SCHEDULE,
  TERMS,
  chargeCalls,
  raised,
  seedCardSchedule,
  seedMandate,
  stubAutoCharge,
  tasksAbout,
} from "@/test/auto-charge-harness";
import { SA, mem, seedSub } from "@/test/paystack-links-harness";

/**
 * Fix round 2 (PR #220): the guard against charging twice in one period is
 * checked when the card is CHARGED, not when the schedule is edited. An edit
 * moves the next run exactly as it does for an invoice schedule — never
 * skipping a month — and a cycle that falls due too soon after the last card
 * charge emails its invoice instead of charging.
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

/** 07:00 SAST on a date. */
const at = (day: string) => new Date(`${day}T05:00:00.000Z`);
/** Local midnight (SAST) of a date, as the schedule stores it. */
const midnight = (day: string) => Timestamp.fromDate(new Date(new Date(`${day}T00:00:00.000Z`).getTime() - 2 * 3_600_000));
const refs = (calls: Parameters<typeof chargeCalls>[0]) => chargeCalls(calls).map((c) => c.body!.reference);
const nextRun = () => (mem.read(`recurringInvoices/${SCHEDULE}`)!.nextRunAt as Timestamp).toDate().toISOString();

async function edit(day: string, body: Record<string, unknown>) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${day}T08:00:00Z`));
  const res = await PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: SA, recurringId: SCHEDULE }),
  });
  vi.useRealTimers();
  expect(res.status).toBe(200);
}

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

describe("a cycle due too soon after the previous cycle", () => {
  it("R5: anchor moved to the 5th the day after a charge → 5 Mar is emailed, 5 Apr is charged", async () => {
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-03-01"));
    await edit("2026-03-02", { anchorDay: 5 });
    expect(nextRun()).toBe("2026-03-04T22:00:00.000Z");

    await runOneSchedule(SCHEDULE, at("2026-03-05"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`]);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
    expect(raised().id).toBe(sendQuoteServerSide.mock.calls[0][0].quoteId);
    const [task] = tasksAbout("too soon");
    expect(task.notes).toBe(
      "This cycle is due 5 March 2026, only 4 days after the previous cycle (1 March 2026) — usually because the billing day " +
        "or frequency was changed — so the card was not charged and the invoice was emailed instead.",
    );
    expect(mem.read(`recurringInvoices/${SCHEDULE}`)!.lastError).toMatch(/only 4 days after the previous cycle/);
    expect(mem.read(`paymentMandates/m1`)!.consecutiveDeclines).toBeUndefined();
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();

    await runOneSchedule(SCHEDULE, at("2026-04-05"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`, `ra-${SCHEDULE}-c6`]);
  });

  it("N5: flip to invoice + move the anchor, flip back to card → no second charge in March", async () => {
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-03-01"));
    await edit("2026-03-02", { chargeMode: "invoice", anchorDay: 5 });
    await edit("2026-03-02", { chargeMode: "card" });
    await runOneSchedule(SCHEDULE, at("2026-03-05"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`]);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
    expect(tasksAbout("too soon")).toHaveLength(1);
  });
});

describe("an edit never skips a month", () => {
  beforeEach(() => seedCardSchedule({ anchorDay: 5, nextRunAt: midnight("2026-03-05") }));

  it("N6: anchor moved earlier (5th → 1st) → 1 Apr, and 1 Apr is charged", async () => {
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-03-05"));
    await edit("2026-03-06", { anchorDay: 1 });
    expect(nextRun()).toBe("2026-03-31T22:00:00.000Z");
    await runOneSchedule(SCHEDULE, at("2026-04-01"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`, `ra-${SCHEDULE}-c5`]);
  });

  it("N6: a new date too close to the charge is emailed, not skipped", async () => {
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-03-05"));
    await edit("2026-03-06", { anchorDay: 20 });
    expect(nextRun()).toBe("2026-03-19T22:00:00.000Z");
    expect(await runOneSchedule(SCHEDULE, at("2026-03-20"))).toMatchObject({ kind: "generated", sent: true });
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`]);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
  });
});

describe("the guard is keyed on cycle due dates, not on when a sweep ran (round 3)", () => {
  it("G2: weekly, one sweep a day late → next week is still charged", async () => {
    seedCardSchedule({ cadence: { unit: "week", interval: 1 }, anchorDay: null, nextRunAt: midnight("2026-03-02") });
    seedMandate({ terms: { ...TERMS, frequency: "every week" } });
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-03-03"));
    await runOneSchedule(SCHEDULE, at("2026-03-09"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`, `ra-${SCHEDULE}-c5`]);
  });

  it("G3: paused over the due date, resumed, caught up 19 Mar → 1 Apr is still charged", async () => {
    const calls = stubAutoCharge();
    await edit("2026-02-25", { status: "paused" });
    expect(await runOneSchedule(SCHEDULE, at("2026-03-01"))).toMatchObject({ kind: "skipped" });
    await edit("2026-03-18", { status: "active" });
    await runOneSchedule(SCHEDULE, at("2026-03-19"));
    await runOneSchedule(SCHEDULE, at("2026-04-01"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`, `ra-${SCHEDULE}-c5`]);
  });

  it("a late sweep does not launder a too-close due date (1 Mar charged, moved to the 20th, swept 30 Mar)", async () => {
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-03-01"));
    await edit("2026-03-02", { anchorDay: 20 });
    await runOneSchedule(SCHEDULE, at("2026-03-30"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`]);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
  });

  it("G4: first cycle paid through the card-on-file link, anchor 1→5 → 5 Mar is emailed, not charged", async () => {
    // No saved card yet: the 1 Mar cycle is emailed, and the customer pays
    // it through the card-on-file link, which saves the card.
    seedCardSchedule({ cardMandateId: null });
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-03-01"));
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
    const current = mem.read(`recurringInvoices/${SCHEDULE}`)!;
    mem.seed(`recurringInvoices/${SCHEDULE}`, { ...current, cardMandateId: "m1" });

    await edit("2026-03-02", { anchorDay: 5 });
    await runOneSchedule(SCHEDULE, at("2026-03-05"));
    expect(refs(calls)).toEqual([]);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(2);
    expect(tasksAbout("too soon")).toHaveLength(1);
  });
});

describe("normal cycles are still charged", () => {
  it("monthly, including 31 Jan → 28 Feb", async () => {
    seedCardSchedule({ anchorDay: 31, nextRunAt: midnight("2026-01-31") });
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-01-31"));
    await runOneSchedule(SCHEDULE, at("2026-02-28"));
    await runOneSchedule(SCHEDULE, at("2026-03-31"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`, `ra-${SCHEDULE}-c5`, `ra-${SCHEDULE}-c6`]);
    expect(sendQuoteServerSide).not.toHaveBeenCalled();
  });

  const lastDue = () => (mem.read(`recurringInvoices/${SCHEDULE}`)!.lastDueAt as Timestamp | undefined)?.toDate().toISOString();

  it("the claim records each billed cycle's due date — not the sweep time — in either mode", async () => {
    stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-03-03"));
    expect(lastDue()).toBe("2026-02-28T22:00:00.000Z");
    seedCardSchedule({ chargeMode: "invoice" });
    await runOneSchedule(SCHEDULE, at("2026-03-01"));
    expect(lastDue()).toBe("2026-02-28T22:00:00.000Z");
  });

  it("a too-stale fast-forward or an already-finished close records nothing", async () => {
    seedCardSchedule({ nextRunAt: midnight("2026-01-01") });
    expect(await runOneSchedule(SCHEDULE, at("2026-03-01"))).toMatchObject({ kind: "skipped", reason: "too_stale" });
    expect(lastDue()).toBeUndefined();
    seedCardSchedule({ endMode: "after_count", maxCycles: 3 });
    expect(await runOneSchedule(SCHEDULE, at("2026-03-01"))).toMatchObject({ kind: "skipped", reason: "already_finished" });
    expect(lastDue()).toBeUndefined();
  });
});
