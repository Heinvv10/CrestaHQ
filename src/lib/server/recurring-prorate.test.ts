import { Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

import { computeQuoteTotals } from "@/lib/quotes/calc";
import { SCHEDULE, chargeCalls, seedCardSchedule, seedMandate, stubAutoCharge, tasksAbout } from "@/test/auto-charge-harness";
import { SA, mem, seedSub } from "@/test/paystack-links-harness";
import type { Quote } from "@/types/quotes";

/**
 * Pro-rating a billing-day change, through the real PATCH route, the real
 * cycle engine and the W5 card path, over the in-memory Firestore. The
 * arithmetic is pinned in `lib/recurring/prorate.test.ts`.
 *
 * Template: R1,000 + 15% tax = R1,150 a month, Africa/Johannesburg.
 */

const sendQuoteServerSide = vi.fn();
const sendPushForEvent = vi.fn();
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
const issueQuoteNumber = vi.fn();
vi.mock("@/lib/quotes/number", () => ({ issueQuoteNumber: (...a: unknown[]) => issueQuoteNumber(...a) }));
vi.mock("@/lib/server/tasks-service", async () => (await import("@/test/auto-charge-harness")).tasksMock());
vi.mock("@/lib/server/quote-send-service", () => ({
  sendQuoteServerSide: (...a: unknown[]) => sendQuoteServerSide(...a),
}));
vi.mock("@/lib/push/send", () => ({ sendPushForEvent: (...a: unknown[]) => sendPushForEvent(...a) }));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => ({ enrolled: [], skipped: [], reason: null })) }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async (_req: Request, subAccountId: string) =>
    subAccountId === "sa1" ? { uid: "u1", agencyId: "ag1" } : NextResponse.json({}, { status: 403 }),
}));

const { runOneSchedule } = await import("./recurring-invoice-service");
const { PATCH } = await import("@/app/api/sub-accounts/[id]/recurring-invoices/[recurringId]/route");
const { commitWithProration, raiseProrationGaps, raisePendingProrations } = await import("./recurring-prorate");
const { recheckStaleAutoCharges } = await import("./auto-charge-stale-sweep");

/** 07:00 SAST on a date. */
const at = (day: string) => new Date(`${day}T05:00:00.000Z`);
/** Local midnight (SAST) of a date. */
const midnight = (day: string) => Timestamp.fromDate(new Date(new Date(`${day}T00:00:00.000Z`).getTime() - 2 * 3_600_000));
const quotes = () => mem.list("quotes") as unknown as (Quote & { id: string })[];
const total = (q: Quote) => computeQuoteTotals(q).total;
const schedule = () => mem.read(`recurringInvoices/${SCHEDULE}`)!;
type StoredGap = { state: string; invoiceId: string | null; docId: string; claimedAt: unknown };
const gaps = () => ((schedule().proration as { gaps: StoredGap[] } | undefined)?.gaps ?? []) as StoredGap[];
const scheduleRef = () => mem.db.doc(`recurringInvoices/${SCHEDULE}`) as unknown as Parameters<typeof raiseProrationGaps>[0];
/** Patch the stored gaps, as a crashed or interrupted raiser would have left them. */
const setGaps = (patch: Partial<StoredGap>) => {
  const current = schedule();
  const proration = current.proration as Record<string, unknown>;
  mem.seed(`recurringInvoices/${SCHEDULE}`, { ...current, prorationDueAt: new Date("2026-07-01T00:00:00.000Z"), proration: { ...proration, gaps: gaps().map((g) => ({ ...g, ...patch })) } });
};

async function edit(day: string, body: Record<string, unknown>) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${day}T08:00:00Z`));
  try {
    return await PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }), {
      params: Promise.resolve({ id: SA, recurringId: SCHEDULE }),
    });
  } finally {
    vi.useRealTimers();
  }
}

/** Billing on the `anchor`th, first billed on `firstDue` (so it has billed once by the test). */
async function billedOnce(anchor: number, firstDue: string, over: Record<string, unknown> = {}) {
  seedCardSchedule({ chargeMode: "invoice", anchorDay: anchor, nextRunAt: midnight(firstDue), ...over });
  await runOneSchedule(SCHEDULE, at(firstDue));
  expect(quotes()).toHaveLength(1);
  // A review-first cycle pushes after the run returns; let it land before the
  // mocks are cleared or it is counted against the next step.
  if (over.reviewFirst) await flushAfterResponse();
  if (over.reviewFirst) expect(sendPushForEvent).toHaveBeenCalledTimes(1);
  vi.clearAllMocks();
}

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  seedSub();
  sendQuoteServerSide.mockResolvedValue({ ok: true });
  let n = 0;
  issueQuoteNumber.mockImplementation(async () => `INV-2026-${String(++n).padStart(4, "0")}`);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("gap: 15th → 20th", () => {
  it("raises and emails ONE pro-rata for 15–19 Jul at the edit; 20 Jul then bills in full", async () => {
    await billedOnce(15, "2026-06-15");
    expect((await edit("2026-07-01", { anchorDay: 20 })).status).toBe(200);

    const [, gap] = quotes();
    expect(gap.lineItems).toEqual([
      { id: "prorate", description: "Pro-rated: 15 Jul – 19 Jul (billing day changed)", quantity: 1, unitPrice: 161.29, productId: null },
    ]);
    expect(total(gap)).toBe(185.48); // R1,150 × 5 ÷ 31
    expect(gap).toMatchObject({ recurringInvoiceId: SCHEDULE, prorated: "gap" });
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
    expect(sendQuoteServerSide.mock.calls[0][0].quoteId).toBe(gap.id);
    expect(gaps()).toMatchObject([{ state: "raised", invoiceId: gap.id }]);
    expect(schedule().prorationDueAt).toBeNull();

    await runOneSchedule(SCHEDULE, at("2026-07-20"));
    expect(quotes()).toHaveLength(3);
    expect(total(quotes()[2])).toBe(1150);
  });

  it("edited on 17 Jun, before the 20th: the next bill is 20 Jul, and an after-count term stays whole", async () => {
    await billedOnce(15, "2026-06-15", { cyclesGenerated: 0, endMode: "after_count", maxCycles: 2 });
    await edit("2026-06-17", { anchorDay: 20 });
    expect((schedule().nextRunAt as Timestamp).toDate()).toEqual(midnight("2026-07-20").toDate());
    expect(quotes()[1].lineItems[0].description).toBe("Pro-rated: 15 Jul – 19 Jul (billing day changed)");
    expect(await runOneSchedule(SCHEDULE, at("2026-06-20"))).toMatchObject({ kind: "skipped" });

    await runOneSchedule(SCHEDULE, at("2026-07-20"));
    expect(total(quotes()[2])).toBe(1150);
    // Two regular cycles (15 Jun, 20 Jul) — the pro-rata is not one of them.
    expect(schedule()).toMatchObject({ cyclesGenerated: 2, status: "completed" });
  });

  it("saving the same edit again raises nothing more", async () => {
    await billedOnce(15, "2026-06-15");
    await edit("2026-07-01", { anchorDay: 20 });
    expect((await edit("2026-07-01", { anchorDay: 20 })).status).toBe(200);
    expect((await edit("2026-07-02", { anchorDay: 20, name: "Renamed" })).status).toBe(200);
    expect(quotes()).toHaveLength(2);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
  });

  it("two saves racing: one pro-rata, and the other is told to reload", async () => {
    await billedOnce(15, "2026-06-15");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T08:00:00Z"));
    const req = () =>
      PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ anchorDay: 20 }) }), {
        params: Promise.resolve({ id: SA, recurringId: SCHEDULE }),
      });
    const statuses = (await Promise.all([req(), req()])).map((r) => r.status).sort();
    vi.useRealTimers();
    expect(statuses).toEqual([200, 409]);
    expect(quotes()).toHaveLength(2);
  });

  it("review-first: the pro-rata is a draft for review, not sent", async () => {
    await billedOnce(15, "2026-06-15", { reviewFirst: true });
    await edit("2026-07-01", { anchorDay: 20 });
    expect(quotes()[1]).toMatchObject({ status: "draft", prorated: "gap" });
    expect(sendQuoteServerSide).not.toHaveBeenCalled();
    await flushAfterResponse();
    expect(sendPushForEvent).toHaveBeenCalledTimes(1);
  });

  it("a card schedule's pro-rata is emailed, never charged, and the Task says it is deliberate; 20 Jul is charged in full", async () => {
    seedMandate();
    const calls = stubAutoCharge();
    seedCardSchedule({ anchorDay: 15, nextRunAt: midnight("2026-06-15") });
    await runOneSchedule(SCHEDULE, at("2026-06-15"));
    expect(chargeCalls(calls)).toHaveLength(1);

    await edit("2026-07-01", { anchorDay: 20 });
    expect(chargeCalls(calls)).toHaveLength(1);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
    expect(sendQuoteServerSide.mock.calls[0][0].quoteId).toBe(quotes()[1].id);
    const [task] = tasksAbout("deliberate");
    expect(task.notes).toContain("not charged to the saved card");
    expect(task.notes).not.toMatch(/fix one/i);

    // The W5 period guard still sees 15 Jun as the last cycle: 20 Jul is 35 days on.
    await runOneSchedule(SCHEDULE, at("2026-07-20"));
    expect(chargeCalls(calls)).toHaveLength(2);
    expect(tasksAbout("too soon")).toHaveLength(0);
  });

  it("a schedule that has not billed yet is not pro-rated", async () => {
    seedCardSchedule({ chargeMode: "invoice", anchorDay: 15, nextRunAt: midnight("2026-07-15"), cyclesGenerated: 0 });
    expect((await edit("2026-07-01", { anchorDay: 20 })).status).toBe(200);
    expect(quotes()).toHaveLength(0);
    expect(schedule().proration).toBeUndefined();
  });

  it("a frequency change is not pro-rated", async () => {
    await billedOnce(15, "2026-06-15");
    await edit("2026-07-01", { cadence: { unit: "quarter", interval: 1 }, anchorDay: 20 });
    expect(quotes()).toHaveLength(1);
  });
});

describe("the sweep guarantees the gap invoice", () => {
  it("a raise that fails at the edit stays pending, with lastError and a Task, and the next sweep raises it", async () => {
    await billedOnce(15, "2026-06-15");
    issueQuoteNumber.mockRejectedValueOnce(new Error("numbering unavailable"));
    expect((await edit("2026-07-01", { anchorDay: 20 })).status).toBe(200);
    expect(quotes()).toHaveLength(1);
    expect(gaps()).toMatchObject([{ state: "pending", invoiceId: null }]);
    expect(schedule().prorationDueAt).toBeInstanceOf(Date);
    expect(schedule().lastError).toMatch(/Pro-rated: 15 Jul – 19 Jul.*could not be raised.*retried/);
    expect(tasksAbout("could not be raised")).toHaveLength(1);

    // A failed gap waits a day at the back of the queue.
    expect(await raisePendingProrations(at("2026-07-02"))).toBe(0);
    expect(await raisePendingProrations(at("2026-07-03"))).toBe(1);
    expect(quotes()).toHaveLength(2);
    expect(quotes()[1].lineItems[0].description).toBe("Pro-rated: 15 Jul – 19 Jul (billing day changed)");
    expect(gaps()).toMatchObject([{ state: "raised" }]);
    expect(schedule().prorationDueAt).toBeNull();
    expect(await raisePendingProrations(at("2026-07-04"))).toBe(0);
    expect(quotes()).toHaveLength(2);
  });

  it("a gap that keeps failing raises ONE Task, while lastError tracks each attempt", async () => {
    await billedOnce(15, "2026-06-15");
    issueQuoteNumber.mockRejectedValueOnce(new Error("numbering unavailable"));
    await edit("2026-07-01", { anchorDay: 20 });
    issueQuoteNumber.mockRejectedValueOnce(new Error("still unavailable"));
    expect(await raisePendingProrations(at("2026-07-03"))).toBe(0);
    expect(tasksAbout("could not be raised")).toHaveLength(1);
    expect(schedule().lastError).toMatch(/still unavailable/);
  });

  it("one schedule failing does not stop the others", async () => {
    await billedOnce(15, "2026-06-15");
    issueQuoteNumber.mockRejectedValueOnce(new Error("numbering unavailable"));
    await edit("2026-07-01", { anchorDay: 20 });
    const other = { ...schedule(), proration: { ...(schedule().proration as object), gaps: gaps().map((g) => ({ ...g, docId: "q-other" })) } };
    mem.seed("recurringInvoices/sch2", other);
    const real = mem.db.runTransaction.bind(mem.db);
    vi.spyOn(mem.db, "runTransaction").mockRejectedValueOnce(new Error("contention")).mockImplementation(real);
    expect(await raisePendingProrations(at("2026-07-03"))).toBe(1);
    expect(quotes()).toHaveLength(2);
  });

  it("a paused schedule still raises its pending gap: those days were delivered", async () => {
    await billedOnce(15, "2026-06-15");
    issueQuoteNumber.mockRejectedValueOnce(new Error("numbering unavailable"));
    await edit("2026-07-01", { anchorDay: 20 });
    await edit("2026-07-02", { status: "paused" });
    expect(await raisePendingProrations(at("2026-07-03"))).toBe(1);
    expect(quotes()).toHaveLength(2);
  });

  it("the edit is saved even when its immediate raise throws; the gap stays pending", async () => {
    await billedOnce(15, "2026-06-15");
    const real = mem.db.runTransaction.bind(mem.db);
    vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(real).mockRejectedValueOnce(new Error("contention")).mockImplementation(real);
    expect((await edit("2026-07-01", { anchorDay: 20 })).status).toBe(200);
    expect(schedule().anchorDay).toBe(20);
    expect(gaps()).toMatchObject([{ state: "pending" }]);
  });

  it("a stale 'raising' claim is retaken; a fresh one is left alone", async () => {
    await billedOnce(15, "2026-06-15");
    issueQuoteNumber.mockRejectedValueOnce(new Error("numbering unavailable"));
    await edit("2026-07-01", { anchorDay: 20 });
    setGaps({ state: "raising", claimedAt: new Date("2026-07-02T04:55:00.000Z") });
    expect(await raisePendingProrations(at("2026-07-02"))).toBe(0); // claimed 5 minutes ago
    expect(await raisePendingProrations(new Date("2026-07-02T06:00:00.000Z"))).toBe(1);
    expect(quotes()).toHaveLength(2);
  });

  it("a retaken claim whose invoice already exists raises no second one and does not re-send", async () => {
    await billedOnce(15, "2026-06-15");
    await edit("2026-07-01", { anchorDay: 20 });
    setGaps({ state: "raising", claimedAt: new Date("2026-07-01T00:00:00.000Z"), invoiceId: null });
    vi.clearAllMocks();
    expect(await raisePendingProrations(at("2026-07-02"))).toBe(1);
    expect(quotes()).toHaveLength(2);
    expect(sendQuoteServerSide).not.toHaveBeenCalled();
    expect(tasksAbout("whether it was sent is unknown")).toHaveLength(1);
    expect(gaps()).toMatchObject([{ state: "raised" }]);
  });

  it("a cancelled schedule's pending gap is dropped, not raised", async () => {
    await billedOnce(15, "2026-06-15");
    issueQuoteNumber.mockRejectedValueOnce(new Error("numbering unavailable"));
    await edit("2026-07-01", { anchorDay: 20 });
    await edit("2026-07-02", { status: "cancelled" });
    expect(await raisePendingProrations(at("2026-07-03"))).toBe(0);
    expect(quotes()).toHaveLength(1);
    expect(schedule().prorationDueAt).toBeNull();
  });

  it("an edit planned before a gap was claimed is refused, not written over the claim", async () => {
    await billedOnce(15, "2026-06-15");
    issueQuoteNumber.mockRejectedValueOnce(new Error("numbering unavailable"));
    await edit("2026-07-01", { anchorDay: 20 });
    const seen = { ...schedule(), id: SCHEDULE } as unknown as Parameters<typeof commitWithProration>[1];
    setGaps({ state: "raising", claimedAt: new Date() });
    expect(await commitWithProration(scheduleRef(), seen, { anchorDay: 15 })).toBe(false);
    expect(schedule().anchorDay).toBe(20);
  });

  it("two raisers at once make one invoice", async () => {
    await billedOnce(15, "2026-06-15");
    issueQuoteNumber.mockRejectedValueOnce(new Error("numbering unavailable"));
    await edit("2026-07-01", { anchorDay: 20 });
    await Promise.all([raiseProrationGaps(scheduleRef(), at("2026-07-02")), raiseProrationGaps(scheduleRef(), at("2026-07-02"))]);
    expect(quotes()).toHaveLength(2);
  });

  it("an unraised gap is cancelled by a revert (15 → 20 → 15): nothing invoiced, nothing credited", async () => {
    await billedOnce(15, "2026-06-15");
    issueQuoteNumber.mockRejectedValueOnce(new Error("numbering unavailable"));
    await edit("2026-07-01", { anchorDay: 20 });
    expect((await edit("2026-07-02", { anchorDay: 15 })).status).toBe(200);
    expect(gaps()).toEqual([]);
    expect(schedule()).toMatchObject({ prorationDueAt: null, proration: { credits: [] } });
    expect(await raisePendingProrations(at("2026-07-03"))).toBe(0);
    await runOneSchedule(SCHEDULE, at("2026-07-15"));
    expect(quotes()).toHaveLength(2);
    expect(total(quotes()[1])).toBe(1150);
  });
});

describe("overlap: 20th → 15th", () => {
  it("credits 15–19 Jul on the 15 Jul invoice, and only on that one", async () => {
    await billedOnce(20, "2026-06-20");
    await edit("2026-07-01", { anchorDay: 15 });
    expect(quotes()).toHaveLength(1);

    await runOneSchedule(SCHEDULE, at("2026-07-15"));
    const credited = quotes()[1];
    expect(total(credited)).toBe(964.52); // R1,150 × (1 − 5 ÷ 31)
    expect(credited).toMatchObject({ globalDiscount: { type: "flat", value: 161.29 }, prorated: "credit" });
    expect(credited.lineItems[1].description).toContain("Pro-rated credit: 15 Jul – 19 Jul (billing day changed)");

    await runOneSchedule(SCHEDULE, at("2026-08-15"));
    expect(total(quotes()[2])).toBe(1150);
  });

  it("a credited cycle that fails before its invoice exists passes the credit to the next invoice", async () => {
    await billedOnce(20, "2026-06-20");
    await edit("2026-07-01", { anchorDay: 15 });
    issueQuoteNumber.mockRejectedValueOnce(new Error("numbering unavailable"));
    expect(await runOneSchedule(SCHEDULE, at("2026-07-15"))).toMatchObject({ kind: "failed" });
    expect(quotes()).toHaveLength(1);
    await runOneSchedule(SCHEDULE, at("2026-08-15"));
    expect(total(quotes()[1])).toBe(964.52);
    await runOneSchedule(SCHEDULE, at("2026-09-15"));
    expect(total(quotes()[2])).toBe(1150);
  });

  it("a credited cycle skipped as too stale passes the credit to the next invoice", async () => {
    await billedOnce(20, "2026-06-20");
    await edit("2026-07-01", { anchorDay: 15 });
    expect(await runOneSchedule(SCHEDULE, at("2026-08-17"))).toMatchObject({ kind: "skipped", reason: "too_stale" });
    await runOneSchedule(SCHEDULE, at("2026-08-18"));
    expect(total(quotes()[1])).toBe(964.52);
  });

  it("15 → 10 → 20 in one period: the gap is 5 ÷ 31 of the 15th cycle the customer paid to (R185.48)", async () => {
    await billedOnce(15, "2026-06-15");
    await edit("2026-07-01", { anchorDay: 10 });
    await edit("2026-07-02", { anchorDay: 20 });
    expect(quotes()).toHaveLength(2);
    expect(total(quotes()[1])).toBe(185.48);
    await runOneSchedule(SCHEDULE, at("2026-07-20"));
    expect(total(quotes()[2])).toBe(1150); // the 10th's credit went with the replan
  });

  it("15 → 20 (raised) → 10: the 10 Jul invoice credits 10–19 Jul, 10 ÷ 31", async () => {
    await billedOnce(15, "2026-06-15");
    await edit("2026-07-01", { anchorDay: 20 });
    await edit("2026-07-02", { anchorDay: 10 });
    await runOneSchedule(SCHEDULE, at("2026-07-10"));
    expect(quotes()[2].globalDiscount).toEqual({ type: "flat", value: 322.58 });
    expect(total(quotes()[2])).toBe(779.03);
  });

  it("an end date before the pro-rated next run is refused", async () => {
    await billedOnce(15, "2026-06-15", { endMode: "on_date", endAt: midnight("2026-07-18") });
    const res = await edit("2026-07-01", { anchorDay: 20 });
    expect(res.status).toBe(400);
    expect(schedule().anchorDay).toBe(15);
    expect(quotes()).toHaveLength(1);
  });

  it("a credit the final invoice cannot carry gets a Task, not silence", async () => {
    await billedOnce(20, "2026-06-20", { cyclesGenerated: 0, endMode: "after_count", maxCycles: 2 });
    await edit("2026-07-01", { anchorDay: 15 });
    await edit("2026-07-02", { lineItems: [{ id: "li1", description: "Fibre", quantity: 1, unitPrice: 100 }] });
    await runOneSchedule(SCHEDULE, at("2026-07-15"));
    expect(total(quotes()[1])).toBe(0);
    expect(schedule().status).toBe("completed");
    const [task] = tasksAbout("was not applied");
    expect(task.notes).toContain("61.29 excl. tax was not applied");
  });

  it("cancelling with a credit still owed raises a Task", async () => {
    await billedOnce(20, "2026-06-20");
    await edit("2026-07-01", { anchorDay: 15 });
    await edit("2026-07-02", { status: "cancelled" });
    expect(tasksAbout("was not applied")).toHaveLength(1);
  });

  it("a card schedule's credited cycle is emailed, and the Task says the difference is deliberate", async () => {
    seedMandate();
    const calls = stubAutoCharge();
    seedCardSchedule({ anchorDay: 20, nextRunAt: midnight("2026-06-20") });
    await runOneSchedule(SCHEDULE, at("2026-06-20"));
    // Moved so the credited cycle is NOT too soon (29 days on): the pro-rata is the only reason.
    await edit("2026-06-22", { anchorDay: 19 });
    await runOneSchedule(SCHEDULE, at("2026-07-19"));
    expect(chargeCalls(calls)).toHaveLength(1);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
    const [task] = tasksAbout("deliberate pro-rated credit");
    expect(`${task.title} ${task.notes}`).not.toMatch(/fix one/i);

    // W5's stale-charge re-check (#237) works from open card attempts. The
    // credited cycle never opened one, so the re-check cannot charge it or
    // turn it into a card payment later.
    expect(mem.list("paymentAttempts").map((a) => a.id)).toEqual([`ra-${SCHEDULE}-c4`]);
    await recheckStaleAutoCharges(at("2026-07-25"));
    expect(chargeCalls(calls)).toHaveLength(1);
    expect(mem.list("paymentAttempts").map((a) => a.id)).toEqual([`ra-${SCHEDULE}-c4`]);
    expect(quotes()[1]).toMatchObject({ prorated: "credit" });
    expect(quotes()[1].autoCharge ?? null).toBeNull();
  });
});
