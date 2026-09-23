import { beforeEach, describe, expect, it, vi } from "vitest";

import { formatCurrency } from "@/lib/format";
import { SA, mem, seedInvoice, seedLink, seedSchedule, seedSub } from "@/test/paystack-links-harness";

/**
 * Creating a card-on-file link: only for an invoice a live recurring schedule
 * raised, with terms fixed from the schedule — amount, frequency, how to stop.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-16";

const { createPaymentLink } = await import("./payment-links-service");

const create = (over: Record<string, unknown> = {}) =>
  createPaymentLink({ subAccountId: SA, uid: "u1", invoiceId: "inv1", mandate: true, ...over });

beforeEach(() => {
  mem.clear();
  seedSub();
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, name: "Acme Fibre" });
  seedInvoice("inv1", { recurringInvoiceId: "rec1" });
  seedSchedule();
});

describe("createPaymentLink with mandate", () => {
  it("fixes the terms from the schedule: amount, frequency and how to stop", async () => {
    const res = await create();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const link = mem.read(`paymentLinks/${res.link.id}`)!;
    expect(link).toMatchObject({ invoiceId: "inv1", recurringInvoiceId: "rec1", amountCents: 115000, mode: "test" });
    const terms = link.mandate as { amountCents: number; currency: string; frequency: string; text: string };
    expect(terms).toMatchObject({ amountCents: 115000, currency: "ZAR", frequency: "every month" });
    expect(terms.text).toContain("Acme Fibre");
    expect(terms.text).toContain(formatCurrency(1150, "ZAR"));
    expect(terms.text).toContain("every month");
    expect(terms.text).toMatch(/to stop future charges/i);
  });

  it.each([
    [{ unit: "week", interval: 1 }, "every week"],
    [{ unit: "week", interval: 2 }, "every 2 weeks"],
    [{ unit: "month", interval: 3 }, "every 3 months"],
    [{ unit: "quarter", interval: 1 }, "every quarter"],
    [{ unit: "year", interval: 1 }, "every year"],
  ])("frequency of %o reads %s", async (cadence, words) => {
    seedSchedule("rec1", { cadence });
    const res = await create();
    expect(res.ok && res.link.mandate?.frequency).toBe(words);
  });

  it("refuses an invoice no recurring schedule raised", async () => {
    seedInvoice("inv1", { recurringInvoiceId: null });
    expect(await create()).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses a schedule that is not active, or not this sub-account's", async () => {
    seedSchedule("rec1", { status: "paused" });
    expect(await create()).toMatchObject({ ok: false, status: 409 });
    seedSchedule("rec1", { subAccountId: "sa2" });
    expect(await create()).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses when the schedule's amount is not this invoice's", async () => {
    seedSchedule("rec1", { globalTaxPercent: null });
    expect(await create()).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses an ad-hoc amount", async () => {
    expect(await create({ invoiceId: undefined, amountCents: 100, description: "x" })).toMatchObject({ ok: false, status: 400 });
  });

  it("keeps one live link per invoice: a card link withdraws an open ordinary link, and back", async () => {
    seedLink("plain", { invoiceId: "inv1", amountCents: 115000 });
    const card = await create();
    expect(card.ok && card.link.id).not.toBe("plain");
    expect(mem.read("paymentLinks/plain")).toMatchObject({ active: false });

    const again = await create();
    expect(again.ok && card.ok && again.link.id).toBe(card.ok && card.link.id);

    const plain = await create({ mandate: false });
    expect(plain.ok && (plain.link.mandate ?? null)).toBeNull();
    expect(card.ok && mem.read(`paymentLinks/${card.link.id}`)).toMatchObject({ active: false });
  });
});
