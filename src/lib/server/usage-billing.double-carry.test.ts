import { describe, expect, it, vi } from "vitest";
import { spyBillingProvider } from "@/test/billing-provider-spies";
import { CHARGE, EMAIL, NOW, SUB, charges, frozen, mail, mem, queue, setupUsageBillingTests } from "@/test/usage-billing-harness";

/**
 * Every withhold goes through one transactional charge check. A charge that
 * already exists and was emailed (or a send attempted) STANDS: the carry folded
 * into it must not also be written back as `carryOutCents`, which would bill
 * it a second time. A charge never emailed is cancelled in the same commit that
 * stamps the ledger. Shared setup: src/test/usage-billing-harness.ts.
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

setupUsageBillingTests();

const AGED = new Date(2026, 8, 20);

/** September owes 5,000c + a 300c carry from August, folded into ONE live charge. */
const frozenWithChargeAndCarry = (opts: { totalCents?: number; charge: Record<string, unknown> }) => {
  mem.seed("subAccounts/sa1/usage/2026-09", {
    emailsSent: 600,
    closed: {
      totalCents: opts.totalCents ?? 5300, currency: "zar", lineItems: [], chargeId: CHARGE,
      carriedInCents: 300, carryOutCents: 0,
    },
  });
  mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09", createdAt: AGED });
  mem.seed(`billingCharges/${CHARGE}`, {
    id: CHARGE, agencyId: "ag1", subAccountId: "sa1", kind: "usage", usageMonth: "2026-09",
    description: "Usage", amountCents: 5300, currency: "zar", status: "pending", tokenHash: null,
    dueAt: new Date(2026, 9, 15), lineItems: [], remindedAt: {}, emailedTo: null, createdAt: NOW, ...opts.charge,
  });
};
const EMAILED = { emailedTo: EMAIL, emailAttemptedAt: NOW };
const closeOctober = async () => {
  mem.seed("subAccounts/sa1/usage/2026-10", { emailsSent: 130 });
  await runUsageClose(new Date(2026, 10, 1, 5, 0));
  return frozen("2026-10");
};

describe("an emailed charge stands: nothing is withheld and no carry is written back", () => {
  it.each([
    ["over the ceiling", async () => { frozenWithChargeAndCarry({ totalCents: 100_000_001, charge: EMAILED }); }],
    ["Paystack, no billing email", async () => {
      spyBillingProvider("paystack");
      mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
      frozenWithChargeAndCarry({ charge: EMAILED });
    }],
    ["the token secret unset", async () => {
      frozenWithChargeAndCarry({ charge: EMAILED });
      vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "");
    }],
    ["the switch turned off", async () => {
      frozenWithChargeAndCarry({ charge: EMAILED });
      mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });
    }],
  ])("%s, queued past the window", async (_l, setup) => {
    spyBillingProvider("stripe");
    await setup();
    const out = await runUsageClose(NOW);
    expect(out).toMatchObject({ failed: 0, refusals: [] });
    expect(frozen()?.withheldAt).toBeUndefined();
    expect(frozen()).toMatchObject({ carryOutCents: 0, carriedInCents: 300 });
    expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({ status: "pending", emailedTo: EMAIL });
    expect(queue()).toHaveLength(0);
  });

  it("inside the window an existing emailed charge is not re-created, so a missing contact raises no refusal", async () => {
    spyBillingProvider("paystack");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    frozenWithChargeAndCarry({ charge: EMAILED });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09", createdAt: NOW });
    const out = await runUsageClose(NOW);
    expect(out).toMatchObject({ failed: 0, refusals: [] });
    expect(queue()).toHaveLength(0);
  });

  it("a send that was attempted counts as sent: not withheld, not written back", async () => {
    spyBillingProvider("paystack");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    frozenWithChargeAndCarry({ charge: { emailAttemptedAt: NOW } });
    await runUsageClose(NOW);
    expect(frozen()?.withheldAt).toBeUndefined();
    expect(frozen()).toMatchObject({ carryOutCents: 0 });
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("pending");
  });

  it("the next month's close does not pick the same carry up a second time", async () => {
    spyBillingProvider("paystack");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    frozenWithChargeAndCarry({ charge: EMAILED });
    await runUsageClose(NOW);
    mem.seed("subAccounts/sa1", SUB);
    expect(await closeOctober()).toMatchObject({ carriedInCents: 0, totalCents: 300 });
  });
});

describe("a charge never emailed is cancelled and the ledger stamped in one commit", () => {
  it.each([
    ["Paystack, no billing email", async () => {
      spyBillingProvider("paystack");
      mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
      frozenWithChargeAndCarry({ charge: {} });
    }],
    ["over the ceiling", async () => {
      spyBillingProvider("stripe");
      frozenWithChargeAndCarry({ totalCents: 100_000_001, charge: {} });
    }],
  ])("%s", async (_l, setup) => {
    await setup();
    const out = await runUsageClose(NOW);
    expect(out).toMatchObject({ failed: 0, refusals: [expect.objectContaining({ subAccountId: "sa1" })] });
    expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({ status: "canceled", tokenHash: null });
    expect(frozen()).toMatchObject({ carryOutCents: 300 });
    expect(frozen()?.withheldAt).toBeDefined();
    expect(queue()).toHaveLength(0);
    expect(charges()).toHaveLength(1);
    mem.seed("subAccounts/sa1", SUB);
    expect(await closeOctober()).toMatchObject({ carriedInCents: 300 });
  });

  it("an email being sent right now is left alone (busy): neither cancelled nor withheld", async () => {
    spyBillingProvider("paystack");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    frozenWithChargeAndCarry({ charge: { invoiceEmailClaimedAt: new Date(NOW.getTime() - 60_000) } });
    await runUsageClose(NOW);
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("pending");
    expect(frozen()?.withheldAt).toBeUndefined();
    expect(queue()).toHaveLength(1);
  });
});
