import { Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

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
const sendPushForEvent = vi.fn();
const fireWorkflowTrigger = vi.fn();

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
const issueQuoteNumber = vi.fn();
vi.mock("@/lib/quotes/number", () => ({ issueQuoteNumber: (...a: unknown[]) => issueQuoteNumber(...a) }));
vi.mock("@/lib/server/tasks-service", async () => (await import("@/test/auto-charge-harness")).tasksMock());
vi.mock("@/lib/server/quote-send-service", () => ({
  sendQuoteServerSide: (...a: unknown[]) => sendQuoteServerSide(...a),
}));
vi.mock("@/lib/push/send", () => ({ sendPushForEvent: (...a: unknown[]) => sendPushForEvent(...a) }));
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
const lastDue = () => (mem.read(`recurringInvoices/${SCHEDULE}`)!.lastDueAt as Timestamp | null | undefined)?.toDate().toISOString();
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
  issueQuoteNumber.mockResolvedValue("INV-2026-0004");
  fireWorkflowTrigger.mockResolvedValue({ enrolled: [], skipped: [], reason: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/*
 * Since billing-day changes are pro-rated (prorate.ts), a later billing day is
 * a gap invoice and the next cycle a full period on — never too soon. What
 * still brings a cycle close to the last charge is an EARLIER day (an
 * overlap): charged 20 Feb, moved to the 15th, the next cycle is 15 Mar, 23
 * days on. These tests use that.
 */
const seedOn20th = (over: Record<string, unknown> = {}) =>
  seedCardSchedule({ anchorDay: 20, nextRunAt: midnight("2026-02-20"), ...over });

describe("a cycle due too soon after the previous cycle", () => {
  it("R5: anchor moved to the 15th the day after a charge on the 20th → 15 Mar is emailed, 15 Apr is charged", async () => {
    seedOn20th();
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-02-20"));
    await edit("2026-02-21", { anchorDay: 15 });
    expect(nextRun()).toBe("2026-03-14T22:00:00.000Z");

    await runOneSchedule(SCHEDULE, at("2026-03-15"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`]);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
    expect(raised().id).toBe(sendQuoteServerSide.mock.calls[0][0].quoteId);
    const [task] = tasksAbout("too soon");
    expect(task.notes).toBe(
      "This cycle is due 15 March 2026, only 23 days after the previous cycle (20 February 2026) — usually because the billing day " +
        "or frequency was changed — so the card was not charged. The invoice was emailed instead.",
    );
    expect(mem.read(`recurringInvoices/${SCHEDULE}`)!.lastError).toMatch(/only 23 days after the previous cycle/);
    expect(mem.read(`paymentMandates/m1`)!.consecutiveDeclines).toBeUndefined();
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();

    await runOneSchedule(SCHEDULE, at("2026-04-15"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`, `ra-${SCHEDULE}-c6`]);
  });

  it("N5: flip to invoice + move the anchor, flip back to card → no second charge within the period", async () => {
    seedOn20th();
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-02-20"));
    await edit("2026-02-21", { chargeMode: "invoice", anchorDay: 15 });
    await edit("2026-02-21", { chargeMode: "card" });
    await runOneSchedule(SCHEDULE, at("2026-03-15"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`]);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
    expect(tasksAbout("too soon")).toHaveLength(1);
  });
});

describe("an edit never skips a month", () => {
  beforeEach(() => seedCardSchedule({ anchorDay: 5, nextRunAt: midnight("2026-03-05") }));

  it("N6: anchor moved earlier (5th → 1st) → 1 Apr is billed, with the 1–5 Apr overlap credited, and 1 May is charged", async () => {
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-03-05"));
    await edit("2026-03-06", { anchorDay: 1 });
    expect(nextRun()).toBe("2026-03-31T22:00:00.000Z");
    await runOneSchedule(SCHEDULE, at("2026-04-01"));
    // Pro-rated (prorate.ts): the credited invoice is not the amount the
    // customer authorised, so it is emailed, never charged.
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`]);
    // R1000 × 4 days ÷ 30 (1 Apr – 1 May), before tax.
    expect(raised().globalDiscount).toEqual({ type: "flat", value: 133.33 });
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
    await runOneSchedule(SCHEDULE, at("2026-05-01"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`, `ra-${SCHEDULE}-c6`]);
  });

  it("N6: anchor moved later (5th → 20th) → 5–19 Apr is a pro-rata (emailed), and 20 Apr is charged", async () => {
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-03-05"));
    await edit("2026-03-06", { anchorDay: 20 });
    expect(nextRun()).toBe("2026-04-19T22:00:00.000Z");
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
    expect(await runOneSchedule(SCHEDULE, at("2026-04-20"))).toMatchObject({ kind: "generated" });
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`, `ra-${SCHEDULE}-c5`]);
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

  it("G3: a monthly sweep 18 days late (1 Mar cycle billed 19 Mar) → 1 Apr is still charged", async () => {
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-03-19"));
    await runOneSchedule(SCHEDULE, at("2026-04-01"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`, `ra-${SCHEDULE}-c5`]);
  });

  it("G3 with #200's resume: charged 1 Feb, paused over 1 Mar, resumed 18 Mar → skips to 1 Apr, which is charged", async () => {
    seedCardSchedule({ nextRunAt: midnight("2026-02-01") });
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-02-01"));
    await edit("2026-02-25", { status: "paused" });
    expect(await runOneSchedule(SCHEDULE, at("2026-03-01"))).toMatchObject({ kind: "skipped" });
    await edit("2026-03-18", { status: "active" });
    expect(nextRun()).toBe("2026-03-31T22:00:00.000Z");
    // The gap to the old lastDueAt (1 Feb) only grew: not "too soon".
    await runOneSchedule(SCHEDULE, at("2026-04-01"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`, `ra-${SCHEDULE}-c5`]);
    expect(sendQuoteServerSide).not.toHaveBeenCalled();
  });

  it("a late sweep does not launder a too-close due date (20 Feb charged, moved to the 15th, swept 20 Mar)", async () => {
    seedOn20th();
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-02-20"));
    await edit("2026-02-21", { anchorDay: 15 });
    await runOneSchedule(SCHEDULE, at("2026-03-20"));
    expect(refs(calls)).toEqual([`ra-${SCHEDULE}-c4`]);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
  });

  it("G4: first cycle paid through the card-on-file link, anchor 20→15 → 15 Mar is emailed, not charged", async () => {
    // No saved card yet: the 20 Feb cycle is emailed, and the customer pays
    // it through the card-on-file link, which saves the card.
    seedOn20th({ cardMandateId: null });
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-02-20"));
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
    const current = mem.read(`recurringInvoices/${SCHEDULE}`)!;
    mem.seed(`recurringInvoices/${SCHEDULE}`, { ...current, cardMandateId: "m1" });

    await edit("2026-02-21", { anchorDay: 15 });
    await runOneSchedule(SCHEDULE, at("2026-03-15"));
    expect(refs(calls)).toEqual([]);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(2);
    expect(tasksAbout("too soon")).toHaveLength(1);
  });
});

describe("round 4: legacy schedules, and a cycle that raised nothing", () => {
  it("L1: a schedule billed before lastDueAt existed falls back to lastRunAt", async () => {
    seedOn20th({ chargeMode: "invoice", nextRunAt: midnight("2026-03-20"), lastRunAt: Timestamp.fromDate(at("2026-02-20")) });
    const calls = stubAutoCharge();
    await edit("2026-02-21", { chargeMode: "card", anchorDay: 15 });
    expect(nextRun()).toBe("2026-03-14T22:00:00.000Z");
    await runOneSchedule(SCHEDULE, at("2026-03-15"));
    expect(refs(calls)).toEqual([]);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
    expect(tasksAbout("too soon")).toHaveLength(1);
  });

  it("C1: a cycle that failed before raising an invoice does not block re-raising that period", async () => {
    seedCardSchedule({ lastDueAt: midnight("2026-02-01"), lastRunAt: Timestamp.fromDate(at("2026-02-01")) });
    const calls = stubAutoCharge();
    issueQuoteNumber.mockRejectedValueOnce(new Error("numbering unavailable"));
    expect(await runOneSchedule(SCHEDULE, at("2026-03-01"))).toMatchObject({ kind: "failed" });
    expect(mem.list("quotes")).toHaveLength(0);
    expect(lastDue()).toBe("2026-01-31T22:00:00.000Z");
    await edit("2026-03-02", { anchorDay: 5 });
    await runOneSchedule(SCHEDULE, at("2026-03-05"));
    expect(refs(calls)).toHaveLength(1);
  });

  it("C1: once the invoice exists, a later failure keeps lastDueAt", async () => {
    stubAutoCharge();
    sendQuoteServerSide.mockRejectedValueOnce(new Error("mailer down"));
    seedCardSchedule({ chargeMode: "invoice" });
    expect(await runOneSchedule(SCHEDULE, at("2026-03-01"))).toMatchObject({ kind: "failed" });
    expect(mem.list("quotes")).toHaveLength(1);
    expect(lastDue()).toBe("2026-02-28T22:00:00.000Z");
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


  it("the claim records each billed cycle's due date — not the sweep time — in either mode", async () => {
    stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-03-03"));
    expect(lastDue()).toBe("2026-02-28T22:00:00.000Z");
    seedCardSchedule({ chargeMode: "invoice" });
    await runOneSchedule(SCHEDULE, at("2026-03-01"));
    expect(lastDue()).toBe("2026-02-28T22:00:00.000Z");
  });

  it("#200's claim refusals record nothing: ran today, contact deleted, a claim that throws", async () => {
    seedCardSchedule({ lastRunAt: Timestamp.fromDate(at("2026-03-01")) });
    expect(await runOneSchedule(SCHEDULE, at("2026-03-01"))).toMatchObject({ kind: "skipped", reason: "ran_today" });
    expect(lastDue()).toBeUndefined();
    seedCardSchedule();
    await mem.db.doc("contacts/c1").delete();
    expect(await runOneSchedule(SCHEDULE, at("2026-03-01"))).toMatchObject({ kind: "skipped", reason: "contact_gone" });
    expect(lastDue()).toBeUndefined();
    seedCardSchedule({ timezone: "Not/AZone" });
    expect(await runOneSchedule(SCHEDULE, at("2026-03-01"))).toMatchObject({ kind: "failed" });
    expect(lastDue()).toBeUndefined();
  });

  it("a card cycle sends no review-draft push; review wins over a stored card mode, and notifies", async () => {
    stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-03-01"));
    expect(sendPushForEvent).not.toHaveBeenCalled();
    seedCardSchedule({ reviewFirst: true });
    const calls = stubAutoCharge();
    await runOneSchedule(SCHEDULE, at("2026-03-01"));
    expect(calls).toHaveLength(0);
    await flushAfterResponse();
    expect(sendPushForEvent).toHaveBeenCalledTimes(1);
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
