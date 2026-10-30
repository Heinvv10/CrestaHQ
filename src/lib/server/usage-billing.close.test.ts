import { describe, expect, it, vi } from "vitest";
import { spyBillingProvider } from "@/test/billing-provider-spies";
import { CHARGE, EMAIL, NOW, AGENCY, charges, events, frozen, mail, mem, payUrlsSent, queue, setupUsageBillingTests } from "@/test/usage-billing-harness";

/**
 * The monthly usage close: one charge per month, the invoice sent once, carry-over, the audit trail. Real service, real billing-service, real provider selection with
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

const { runUsageClose } = await import("./usage-billing-service");
const { verifyChargeToken } = await import("@/lib/billing/token");
const { createUsageCharge, listChargesForSubAccount } = await import("./billing-service");

setupUsageBillingTests();

describe("the close creates exactly one charge", () => {
  it("freezes the month, mints the charge with its fields, emails it once", async () => {
    spyBillingProvider("stripe");
    const out = await runUsageClose(NOW);
    expect(out).toMatchObject({ closed: 1, charged: 1, reminded: 0, failed: 0 });

    expect(frozen()).toMatchObject({
      totalCents: 5000,
      currency: "zar",
      chargeId: CHARGE,
      lineItems: [{ label: "Emails", amountCents: 5000, detail: "500 billable" }],
    });
    const [charge] = charges();
    expect(charges()).toHaveLength(1);
    expect(charge).toMatchObject({
      id: CHARGE,
      kind: "usage",
      usageMonth: "2026-09",
      amountCents: 5000,
      currency: "zar",
      status: "pending",
      subAccountId: "sa1",
      agencyId: "ag1",
      emailedTo: EMAIL,
    });
    expect(queue()).toHaveLength(0);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it("stores no raw pay token: the emailed link is minted for the email and only its hash is kept", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    const doc = mem.read(`billingCharges/${CHARGE}`)!;
    expect(doc.payUrl).toBeUndefined();
    const url = payUrlsSent()[0];
    expect(url).toMatch(/^https:\/\/app\.example\.com\/pay\/charge\/usage_sa1_2026-09\./);
    const token = url.split("/pay/charge/")[1];
    expect(verifyChargeToken(token)?.hash).toBe(doc.tokenHash);
    expect(JSON.stringify(doc)).not.toContain(token);
  });

  it("re-running the close creates no second charge and sends no second email", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    const second = await runUsageClose(NOW);
    expect(second).toMatchObject({ closed: 0, charged: 0 });
    expect(charges()).toHaveLength(1);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it("two overlapping runs create one charge and send one email", async () => {
    spyBillingProvider("stripe");
    await Promise.all([runUsageClose(NOW), runUsageClose(NOW)]);
    expect(charges()).toHaveLength(1);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it("a charge that already exists is never overwritten by a re-queued month", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    // The client paid; then a crashed run left the month queued again.
    mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, status: "paid" });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    const out = await runUsageClose(NOW);
    expect(out.charged).toBe(0);
    expect(charges()).toHaveLength(1);
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("paid");
    expect(queue()).toHaveLength(0);
  });

  it("createUsageCharge itself: the second call reports created:false and leaves the first untouched", async () => {
    spyBillingProvider("stripe");
    const input = {
      agencyId: "ag1", subAccountId: "sa1", month: "2026-09", description: "Usage", amountCents: 5000,
      currency: "zar", lineItems: [], dueAt: new Date(2026, 9, 15), payerEmail: EMAIL,
    };
    const first = await createUsageCharge(input);
    const hash = mem.read(`billingCharges/${CHARGE}`)?.tokenHash;
    const second = await createUsageCharge({ ...input, amountCents: 9999 });
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, chargeId: CHARGE });
    expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({ amountCents: 5000, tokenHash: hash });
  });
});

describe("the invoice email is sent once", () => {
  /** A month frozen and its charge minted, but the email step not finished. */
  const midway = async (patch: Record<string, unknown>) => {
    spyBillingProvider("stripe");
    await createUsageCharge({
      agencyId: "ag1", subAccountId: "sa1", month: "2026-09", description: "Usage", amountCents: 5000,
      currency: "zar", lineItems: [], dueAt: new Date(2026, 9, 15), payerEmail: EMAIL,
    });
    mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, ...patch });
    mem.seed("subAccounts/sa1/usage/2026-09", {
      emailsSent: 600,
      closed: { totalCents: 5000, currency: "zar", lineItems: [], chargeId: CHARGE, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
  };

  it("a run holding a fresh claim keeps the email: another run neither sends nor drops the entry", async () => {
    await midway({ invoiceEmailClaimedAt: new Date(NOW.getTime() - 60_000) });
    await runUsageClose(NOW);
    expect(mail.send).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(1);
  });

  it("a claim from a dead run (older than 15 minutes) is taken over", async () => {
    await midway({ invoiceEmailClaimedAt: new Date(NOW.getTime() - 16 * 60_000) });
    await runUsageClose(NOW);
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mem.read(`billingCharges/${CHARGE}`)?.emailedTo).toBe(EMAIL);
    expect(queue()).toHaveLength(0);
  });

  it("an already-emailed charge is not emailed again and its entry is dropped", async () => {
    await midway({ emailedTo: EMAIL });
    await runUsageClose(NOW);
    expect(mail.send).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(0);
  });

  it("a failed send releases the claim so tomorrow's run tries again", async () => {
    await midway({});
    mail.send.mockRejectedValueOnce(new Error("smtp down"));
    await runUsageClose(NOW);
    expect(mem.read(`billingCharges/${CHARGE}`)?.emailedTo).toBeNull();
    expect(mem.read(`billingCharges/${CHARGE}`)?.invoiceEmailClaimedAt).toBeUndefined();
    expect(queue()).toHaveLength(1);
    await runUsageClose(new Date(NOW.getTime() + 86_400_000));
    expect(mem.read(`billingCharges/${CHARGE}`)?.emailedTo).toBe(EMAIL);
    expect(queue()).toHaveLength(0);
  });
});

describe("below the minimum", () => {
  it("is carried into the next month's charge, not charged", async () => {
    spyBillingProvider("stripe");
    // 30 over at 10c = 300c, under the 500c minimum.
    mem.seed("subAccounts/sa1/usage/2026-09", { emailsSent: 130 });
    await runUsageClose(NOW);
    expect(frozen()).toMatchObject({ totalCents: 300, carryOutCents: 300, chargeId: null });
    expect(charges()).toHaveLength(0);

    mem.seed("subAccounts/sa1/usage/2026-10", { emailsSent: 150 });
    await runUsageClose(new Date(2026, 10, 1, 5, 0));
    expect(frozen("2026-10")).toMatchObject({ totalCents: 800, carriedInCents: 300, carryOutCents: 0 });
    expect(mem.read("billingCharges/usage_sa1_2026-10")).toMatchObject({ amountCents: 800 });
  });
});

describe("carry-over", () => {
  const closedAug = (over: Record<string, unknown>) =>
    mem.seed("subAccounts/sa1/usage/2026-08", {
      closed: { totalCents: 300, currency: "zar", lineItems: [], chargeId: null, carryOutCents: 300, ...over },
    });
  /** Close October (usage 130 emails = 300c) at 1 November. */
  const closeOctober = async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-09", {});
    mem.seed("subAccounts/sa1/usage/2026-10", { emailsSent: 150 });
    await runUsageClose(new Date(2026, 10, 1, 5, 0));
    return frozen("2026-10");
  };

  it("steps over a gap: a carry two months back is applied", async () => {
    closedAug({});
    expect(await closeOctober()).toMatchObject({ carriedInCents: 300, totalCents: 800 });
  });

  it("a carry three months back is NOT applied, and says so", async () => {
    mem.seed("subAccounts/sa1/usage/2026-07", {
      closed: { totalCents: 300, currency: "zar", lineItems: [], chargeId: null, carryOutCents: 300 },
    });
    expect(await closeOctober()).toMatchObject({ carriedInCents: 0, totalCents: 500 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/carry of 300 not applied sa=sa1 month=2026-10: it is from 2026-07/));
    // Still on record on the old month.
    expect((mem.read("subAccounts/sa1/usage/2026-07")?.closed as { carryOutCents: number }).carryOutCents).toBe(300);
  });

  it("a carry in another currency is not applied, is logged, and stays on its ledger", async () => {
    closedAug({ currency: "usd" });
    expect(await closeOctober()).toMatchObject({ carriedInCents: 0, totalCents: 500 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/carry of 300 not applied .* currency usd is not zar/));
    expect((mem.read("subAccounts/sa1/usage/2026-08")?.closed as { carryOutCents: number }).carryOutCents).toBe(300);
  });
});

describe("audit trail", () => {
  it("writes a billingEvents row for a freeze, a skip and the charge", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    expect(await events("usage.frozen")).toEqual([
      expect.objectContaining({ subAccountId: "sa1", agencyId: "ag1", detail: expect.objectContaining({ month: "2026-09", totalCents: 5000, chargeId: CHARGE }) }),
    ]);
    expect(await events("charge.created")).toHaveLength(1);

    mem.seed("subAccounts/sa1/usage/2026-10", { emailsSent: 600 });
    mem.seed("agencies/ag1", { ...AGENCY, usageRebillingEnabled: false });
    await runUsageClose(new Date(2026, 10, 1, 5, 0));
    expect(await events("usage.skipped")).toEqual([
      expect.objectContaining({ detail: { month: "2026-10", reason: "agency_off" } }),
    ]);
  });

  it("a re-run writes no second freeze row", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    await runUsageClose(NOW);
    expect(await events("usage.frozen")).toHaveLength(1);
  });
});

describe("serialising a usage charge", () => {
  it("the charge list returns kind, usageMonth and dueAt (and a manual charge is still manual)", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    mem.seed("billingCharges/m1", {
      id: "m1", agencyId: "ag1", subAccountId: "sa1", description: "Web design", amountCents: 9900,
      currency: "zar", status: "pending",
    });
    const list = await listChargesForSubAccount("ag1", "sa1");
    expect(list.find((c) => c.id === CHARGE)).toMatchObject({
      kind: "usage",
      usageMonth: "2026-09",
      dueAt: new Date(NOW.getTime() + 14 * 86_400_000).toISOString(),
    });
    expect(list.find((c) => c.id === "m1")).toMatchObject({ kind: "manual", usageMonth: null, dueAt: null });
  });
});
