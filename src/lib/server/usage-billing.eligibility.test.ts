import { describe, expect, it, vi } from "vitest";
import { spyBillingProvider } from "@/test/billing-provider-spies";
import { CHARGE, EMAIL, NOW, SUB, AGENCY, charges, events, frozen, mail, mem, queue, setupUsageBillingTests } from "@/test/usage-billing-harness";

/**
 * Which months are billed: both switches, the `since` rule at the freeze and the mint, and a switch turned off after the freeze. Real service, real billing-service, real provider selection with
 * every provider method spied (nothing reaches Stripe or Paystack), in-memory
 * Firestore; only the mail transport is replaced, by a spy. Shared setup:
 * src/test/usage-billing-harness.ts.
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/comms/platform-email", () => ({
  resolvePlatformSender: async () => mail.sender,
  sendPlatformEmail: (...a: unknown[]) => mail.send(...a),
  noPlatformSender: () => new Error("no sender"),
}));
vi.mock("@/lib/landing/resolve-brand", () => ({ resolveCustomBrand: async () => ({ name: "Agency" }) }));

const { runUsageClose, freezeMonthForSubAccount } = await import("./usage-billing-service");

setupUsageBillingTests();

describe("both switches are required", () => {
  it("agency master off: the month is closed as skipped, nothing queued or charged", async () => {
    spyBillingProvider("stripe");
    mem.seed("agencies/ag1", { ...AGENCY, usageRebillingEnabled: false });
    await runUsageClose(NOW);
    expect(frozen()).toMatchObject({ skipped: true, totalCents: 0, chargeId: null });
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(0);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("client switch off (read fresh at freeze): skipped, even with the agency on", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });
    // The stale doc the caller holds still says on; the stored doc decides.
    const closed = await freezeMonthForSubAccount({
      sub: { ...SUB, id: "sa1" } as never,
      month: "2026-09",
    });
    expect(closed).toBe(true);
    expect(frozen()).toMatchObject({ skipped: true, chargeId: null });
    expect(queue()).toHaveLength(0);
  });

  it.each([
    ["client enabled mid-month", { sub: new Date(2026, 8, 10) }, "client_switched_on_after_month_start"],
    ["agency enabled mid-month", { agency: new Date(2026, 8, 10) }, "agency_switched_on_after_month_start"],
    ["client enabled one second after the month began", { sub: new Date(2026, 8, 1, 0, 0, 1) }, "client_switched_on_after_month_start"],
    ["client enabled after the month ended", { sub: new Date(2026, 9, 1, 0, 0, 1) }, "client_switched_on_after_month_start"],
    ["client since unparseable", { sub: "last tuesday" }, "client_switched_on_after_month_start"],
    ["client since missing with the switch on", { sub: undefined }, "client_switched_on_after_month_start"],
    ["agency since unparseable", { agency: { seconds: 1 } }, "agency_switched_on_after_month_start"],
    ["agency since missing with the switch on", { agency: undefined }, "agency_switched_on_after_month_start"],
  ])("%s: the month is not billed (first full month onward)", async (_label, since, reason) => {
    spyBillingProvider("stripe");
    if ("sub" in since) mem.seed("subAccounts/sa1", { ...SUB, usageRebillingSince: since.sub });
    if ("agency" in since) mem.seed("agencies/ag1", { ...AGENCY, usageRebillingSince: since.agency });
    await runUsageClose(NOW);
    expect(frozen()).toMatchObject({ skipped: true, skippedReason: reason });
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(0);
  });

  it("a switch on exactly at the month's first instant bills that month", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingSince: new Date(2026, 8, 1, 0, 0, 0, 0) });
    await runUsageClose(NOW);
    expect(charges()).toHaveLength(1);
  });

  it("a client enabled mid-month is billed from its first FULL month", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingSince: new Date(2026, 9, 10) });
    mem.seed("subAccounts/sa1/usage/2026-10", { emailsSent: 600 });
    await runUsageClose(new Date(2026, 10, 1, 5, 0));
    expect(frozen("2026-10")).toMatchObject({ skipped: true });
    await freezeMonthForSubAccount({ sub: { ...SUB, id: "sa1" } as never, month: "2026-11" });
    expect(frozen("2026-11")).not.toHaveProperty("skipped");
  });

  it("a switch turned off between the freeze and the charge withholds it", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });
    mem.seed("subAccounts/sa1/usage/2026-09", {
      emailsSent: 600,
      closed: { totalCents: 5000, currency: "zar", lineItems: [], chargeId: CHARGE, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    const out = await runUsageClose(NOW);
    expect(out.charged).toBe(0);
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(0);
    expect(frozen()?.withheldAt).toBeDefined();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("a client with the switch on under an agency with it off is never charged", async () => {
    spyBillingProvider("stripe");
    mem.seed("agencies/ag1", { ...AGENCY, usageRebillingEnabled: undefined });
    await runUsageClose(NOW);
    expect(charges()).toHaveLength(0);
  });
});

describe("a switch turned off after the freeze", () => {
  /** The month is frozen and queued, then a client switch goes off. */
  const frozenThenOff = async (setup?: () => Promise<void>) => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW); // freeze + charge + invoice email
    mem.seed("usagePendingCharges/" + CHARGE, { subAccountId: "sa1", month: "2026-09" });
    await setup?.();
    mail.send.mockClear();
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });
  };
  const unsent = (extra: Record<string, unknown> = {}) => {
    const d = mem.read(`billingCharges/${CHARGE}`)!;
    mem.seed(`billingCharges/${CHARGE}`, {
      ...d, emailedTo: null, invoiceEmailClaimedAt: undefined, emailAttemptedAt: undefined, ...extra,
    });
  };
  const DUE = new Date(2026, 9, 15, 12, 0);
  const day = (d: number) => new Date(2026, 9, d, 5, 0);

  it("a charge minted but never emailed is cancelled, the month is withheld, and no reminder follows", async () => {
    await frozenThenOff(async () => {
      unsent({ dueAt: DUE });
    });
    const out = await runUsageClose(NOW);
    expect(out.failed).toBe(0);
    expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({ status: "canceled", tokenHash: null });
    expect(frozen()?.withheldAt).toBeDefined();
    expect(queue()).toHaveLength(0);
    expect(mail.send).not.toHaveBeenCalled();
    for (const d of [12, 15, 16, 20]) await runUsageClose(day(d));
    expect(mail.send).not.toHaveBeenCalled();
    expect((await events("charge.canceled")).map((e) => e.detail)).toEqual([
      expect.objectContaining({ chargeId: CHARGE, reason: "rebilling_switched_off_before_invoice" }),
    ]);
    expect(await events("usage.withheld")).toEqual([
      expect.objectContaining({ detail: { month: "2026-09", chargeId: CHARGE, chargeCanceled: true, reason: "rebilling_switched_off_before_invoice", carryBackCents: 0 } }),
    ]);
  });

  it("once the invoice was emailed the debt stands: nothing is cancelled and reminders continue", async () => {
    await frozenThenOff(async () => {
      const d = mem.read(`billingCharges/${CHARGE}`)!;
      mem.seed(`billingCharges/${CHARGE}`, { ...d, dueAt: DUE });
    });
    await runUsageClose(NOW);
    expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({ status: "pending", emailedTo: EMAIL });
    expect(frozen()?.withheldAt).toBeUndefined();
    expect(queue()).toHaveLength(0);
    expect((await runUsageClose(day(12))).reminded).toBe(1);
    expect((await runUsageClose(day(16))).reminded).toBe(1);
  });

  it("an email being sent right now is not cancelled under it", async () => {
    await frozenThenOff(async () => {
      unsent({ invoiceEmailClaimedAt: new Date(NOW.getTime() - 60_000) });
    });
    await runUsageClose(NOW);
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("pending");
    expect(queue()).toHaveLength(1);
    expect(frozen()?.withheldAt).toBeUndefined();
  });

  it.each([
    ["client toggled off and on again", { sub: new Date(2026, 9, 1, 0, 0, 1) }],
    ["agency toggled off and on again", { agency: new Date(2026, 9, 1, 0, 0, 1) }],
    ["client since now missing", { sub: undefined }],
    ["agency since now unreadable", { agency: "later" }],
  ])("%s between the freeze and a delayed mint: both switches are on but the month no longer qualifies, so nothing is billed", async (_l, since) => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-09", {
      emailsSent: 600,
      closed: { totalCents: 5000, currency: "zar", lineItems: [], chargeId: CHARGE, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    if ("sub" in since) mem.seed("subAccounts/sa1", { ...SUB, usageRebillingSince: since.sub });
    if ("agency" in since) mem.seed("agencies/ag1", { ...AGENCY, usageRebillingSince: since.agency });
    const out = await runUsageClose(NOW);
    expect(out.charged).toBe(0);
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(0);
    expect(frozen()?.withheldAt).toBeDefined();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("an invoice email that failed, then the switch goes off: the next run cancels the charge and no reminder is ever sent", async () => {
    spyBillingProvider("stripe");
    mail.send.mockRejectedValueOnce(new Error("smtp down"));
    await runUsageClose(NOW);
    const charge = mem.read(`billingCharges/${CHARGE}`)!;
    expect(charge).toMatchObject({ status: "pending", emailedTo: null });
    expect(queue()).toHaveLength(1);
    mem.seed(`billingCharges/${CHARGE}`, { ...charge, dueAt: new Date(2026, 9, 15, 12, 0) });

    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });
    mail.send.mockClear();
    await runUsageClose(new Date(2026, 9, 2, 5, 0));
    expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({ status: "canceled", tokenHash: null });
    expect(frozen()?.withheldAt).toBeDefined();
    expect(queue()).toHaveLength(0);
    for (const d of [12, 15, 16]) await runUsageClose(new Date(2026, 9, d, 5, 0));
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("a withheld month stays unbilled on every re-run", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });
    mem.seed("subAccounts/sa1/usage/2026-09", {
      emailsSent: 600,
      closed: { totalCents: 5000, currency: "zar", lineItems: [], chargeId: CHARGE, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    await runUsageClose(NOW);
    // Even switched back on, the withheld month is not re-queued or billed.
    mem.seed("subAccounts/sa1", SUB);
    const again = await runUsageClose(new Date(2026, 9, 2, 5, 0));
    expect(again).toMatchObject({ closed: 0, charged: 0 });
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(0);
    expect(mail.send).not.toHaveBeenCalled();
  });
});
