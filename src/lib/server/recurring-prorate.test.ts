import { Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const { raiseGapInvoice } = await import("./recurring-prorate");

/** 07:00 SAST on a date. */
const at = (day: string) => new Date(`${day}T05:00:00.000Z`);
/** Local midnight (SAST) of a date. */
const midnight = (day: string) => Timestamp.fromDate(new Date(new Date(`${day}T00:00:00.000Z`).getTime() - 2 * 3_600_000));
const quotes = () => mem.list("quotes") as unknown as (Quote & { id: string })[];
const total = (q: Quote) => computeQuoteTotals(q).total;
const schedule = () => mem.read(`recurringInvoices/${SCHEDULE}`)!;

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
  it("raises and emails ONE pro-rata for 15–20 Jul at the edit; 20 Jul then bills in full", async () => {
    await billedOnce(15, "2026-06-15");
    expect((await edit("2026-07-01", { anchorDay: 20 })).status).toBe(200);

    const [, gap] = quotes();
    expect(gap.lineItems).toEqual([
      { id: "prorate", description: "Pro-rated: 15 Jul – 20 Jul (billing day changed)", quantity: 1, unitPrice: 161.29, productId: null },
    ]);
    expect(total(gap)).toBe(185.48); // R1,150 × 5 ÷ 31
    expect(gap.recurringInvoiceId).toBe(SCHEDULE);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
    expect(sendQuoteServerSide.mock.calls[0][0].quoteId).toBe(gap.id);
    expect(schedule().proration).toMatchObject({ gap: { invoiceId: gap.id, days: 5, cycleDays: 31 } });

    await runOneSchedule(SCHEDULE, at("2026-07-20"));
    expect(quotes()).toHaveLength(3);
    expect(total(quotes()[2])).toBe(1150);
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

  it("the gap invoice is claimed before it is raised: two raisers make one invoice", async () => {
    await billedOnce(15, "2026-06-15");
    await edit("2026-07-01", { anchorDay: 20 });
    const current = schedule();
    const proration = current.proration as Record<string, Record<string, unknown>>;
    mem.seed(`recurringInvoices/${SCHEDULE}`, { ...current, proration: { ...proration, gap: { ...proration.gap, invoiceId: null } } });
    const ref = mem.db.doc(`recurringInvoices/${SCHEDULE}`) as unknown as Parameters<typeof raiseGapInvoice>[0];
    await Promise.all([raiseGapInvoice(ref, at("2026-07-01")), raiseGapInvoice(ref, at("2026-07-01"))]);
    expect(quotes()).toHaveLength(3);
  });

  it("a pro-rata that cannot be raised is left to a human, with a Task", async () => {
    await billedOnce(15, "2026-06-15");
    issueQuoteNumber.mockRejectedValueOnce(new Error("numbering unavailable"));
    expect((await edit("2026-07-01", { anchorDay: 20 })).status).toBe(200);
    expect(quotes()).toHaveLength(1);
    expect(schedule().lastError).toMatch(/Pro-rated: 15 Jul – 20 Jul.*could not be raised.*Raise it by hand/);
    expect(tasksAbout("could not be raised")).toHaveLength(1);
  });

  it("review-first: the pro-rata is a draft for review, not sent", async () => {
    await billedOnce(15, "2026-06-15", { reviewFirst: true });
    await edit("2026-07-01", { anchorDay: 20 });
    expect(quotes()[1]).toMatchObject({ status: "draft" });
    expect(sendQuoteServerSide).not.toHaveBeenCalled();
    expect(sendPushForEvent).toHaveBeenCalledTimes(1);
  });

  it("a card schedule's pro-rata is emailed, never charged; 20 Jul is charged in full", async () => {
    seedMandate();
    const calls = stubAutoCharge();
    seedCardSchedule({ anchorDay: 15, nextRunAt: midnight("2026-06-15") });
    await runOneSchedule(SCHEDULE, at("2026-06-15"));
    expect(chargeCalls(calls)).toHaveLength(1);

    await edit("2026-07-01", { anchorDay: 20 });
    expect(chargeCalls(calls)).toHaveLength(1);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
    expect(sendQuoteServerSide.mock.calls[0][0].quoteId).toBe(quotes()[1].id);

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

describe("overlap: 20th → 15th", () => {
  it("credits 15–20 Jul on the 15 Jul invoice, and only on that one", async () => {
    await billedOnce(20, "2026-06-20");
    await edit("2026-07-01", { anchorDay: 15 });
    expect(quotes()).toHaveLength(1);

    await runOneSchedule(SCHEDULE, at("2026-07-15"));
    const credited = quotes()[1];
    expect(total(credited)).toBe(964.52); // R1,150 × (1 − 5 ÷ 31)
    expect(credited.globalDiscount).toEqual({ type: "flat", value: 161.29 });
    expect(credited.lineItems[1].description).toContain("Pro-rated credit: 15 Jul – 20 Jul (billing day changed)");

    await runOneSchedule(SCHEDULE, at("2026-08-15"));
    expect(total(quotes()[2])).toBe(1150);
  });

  it("a frequency change that orphans a pending credit says so", async () => {
    await billedOnce(20, "2026-06-20");
    await edit("2026-07-01", { anchorDay: 15 });
    // Weekly from today: the 15 Jul cycle the credit was owed on is gone.
    await edit("2026-07-02", { cadence: { unit: "week", interval: 1 } });
    expect(schedule().lastError).toMatch(/Pro-rated credit: 15 Jul – 20 Jul.*was not applied.*Credit it by hand/);
    expect(tasksAbout("was not applied")).toHaveLength(1);
    await runOneSchedule(SCHEDULE, at("2026-07-02"));
    expect(total(quotes()[1])).toBe(1150);
  });
});
