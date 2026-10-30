import { describe, expect, it, vi } from "vitest";
import { spyBillingProvider } from "@/test/billing-provider-spies";
import { CHARGE, EMAIL, NOW, SUB, AGENCY, charges, events, frozen, mail, mem, queue, setupUsageBillingTests } from "@/test/usage-billing-harness";

/**
 * Withheld, refused and held months: stale claims, carry kept on a withhold, the ceiling, the token secret, and nobody to email. Real service, real billing-service, real provider selection with
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

describe("a stale claim after a switch-off", () => {
  const setup = async (patch: Record<string, unknown>) => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    mem.seed(`billingCharges/${CHARGE}`, {
      ...mem.read(`billingCharges/${CHARGE}`)!, emailedTo: null,
      invoiceEmailClaimedAt: new Date(NOW.getTime() - 60 * 60_000), emailAttemptedAt: undefined, ...patch,
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });
    mail.send.mockClear();
  };

  it("a run that died AFTER stamping its send attempt may have emailed: the debt stands, nothing is cancelled", async () => {
    await setup({ emailAttemptedAt: new Date(NOW.getTime() - 60 * 60_000) });
    await runUsageClose(NOW);
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("pending");
    expect(frozen()?.withheldAt).toBeUndefined();
  });

  it("a stale claim with no attempt marker never sent anything: the charge is cancelled", async () => {
    await setup({});
    await runUsageClose(NOW);
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("canceled");
    expect(frozen()?.withheldAt).toBeDefined();
  });
});

describe("a withheld month keeps the carry that was folded into it", () => {
  /** Aug carried 300c; September (600 emails = 5,000c) is frozen with it, then it cannot be billed. */
  const frozenWithCarry = async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-08", {
      closed: { totalCents: 300, currency: "zar", lineItems: [], chargeId: null, carryOutCents: 300 },
    });
    await freezeMonthForSubAccount({ sub: { ...SUB, id: "sa1" } as never, month: "2026-09" });
    expect(frozen()).toMatchObject({ carriedInCents: 300, totalCents: 5300, carryOutCents: 0 });
  };
  /** October (150 emails = 500c over... 130 = 300c) closes afterwards, picking up what is owed. */
  const closeOctober = async () => {
    mem.seed("subAccounts/sa1", SUB);
    mem.seed("agencies/ag1", AGENCY);
    mem.seed("subAccounts/sa1/usage/2026-10", { emailsSent: 130 });
    await runUsageClose(new Date(2026, 10, 1, 5, 0));
    return frozen("2026-10");
  };

  it("withheld because a switch went off before the invoice", async () => {
    await frozenWithCarry();
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });
    await runUsageClose(NOW);
    expect(frozen()).toMatchObject({ withheldReason: "rebilling_switched_off_before_invoice", carryOutCents: 300 });
    expect(await closeOctober()).toMatchObject({ carriedInCents: 300, totalCents: 600 });
  });

  it("withheld because the invoice could not be sent in 7 days", async () => {
    await frozenWithCarry();
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    await runUsageClose(NOW);
    await runUsageClose(new Date(Date.now() + 8 * 86_400_000));
    expect(frozen()).toMatchObject({ withheldReason: "invoice could not be sent", carryOutCents: 300 });
    expect(await closeOctober()).toMatchObject({ carriedInCents: 300 });
  });

  it("withheld as over the ceiling", async () => {
    await frozenWithCarry();
    mem.seed("subAccounts/sa1/usage/2026-09", {
      closed: { ...(frozen() as object), totalCents: 100_000_001 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09", createdAt: new Date(2026, 8, 20) });
    await runUsageClose(NOW);
    expect(frozen()).toMatchObject({ withheldReason: "over ceiling", carryOutCents: 300 });
    expect(await closeOctober()).toMatchObject({ carriedInCents: 300 });
  });
});

describe("a sub-account with no agency", () => {
  it("is a refusal, not a daily failure, and builds no path from the empty id", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, agencyId: "" });
    mem.seed("subAccounts/sa1/usage/2026-09", {
      closed: { totalCents: 5000, currency: "zar", lineItems: [], chargeId: CHARGE, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    const out = await runUsageClose(NOW);
    expect(out).toMatchObject({ failed: 0, refusals: [{ subAccountId: "sa1", reason: "the sub-account has no agency" }] });
    expect(charges()).toHaveLength(0);
  });
});

describe("a charge that cannot be created", () => {
  it("over the ceiling: no charge, the month is held with a logged reason, retried each run", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-09", {
      closed: { totalCents: 100_000_001, currency: "zar", lineItems: [], chargeId: CHARGE, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    const out = await runUsageClose(NOW);
    expect(out).toMatchObject({ failed: 0, refusals: [{ subAccountId: "sa1", month: "2026-09", reason: expect.stringMatching(/^amountCents must be/) }] });
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/held, needs a fix sa=sa1 month=2026-09: amountCents must be/));
    expect((await runUsageClose(NOW)).refusals).toHaveLength(1);
  });

  it("an UNEXPECTED error (Firestore unavailable) is a failure, not a refusal, and the entry is kept", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-09", {
      closed: { totalCents: 5000, currency: "zar", lineItems: [], chargeId: CHARGE, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    const tx = vi.spyOn(mem.db, "runTransaction").mockRejectedValueOnce(Object.assign(new Error("14 UNAVAILABLE"), { code: 14 }));
    const out = await runUsageClose(NOW);
    tx.mockRestore();
    expect(out).toMatchObject({ failed: 1, refusals: [] });
    expect(queue()).toHaveLength(1);
    // The next run recovers and mints it.
    // (The charge doc itself was already created before the failure, so this run mints nothing new.)
    expect((await runUsageClose(NOW)).charged).toBe(0);
    expect(charges()).toHaveLength(1);
  });

  it("still over the ceiling after 7 days queued: the month is withheld as 'over ceiling', audited, and reported once", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-09", {
      closed: { totalCents: 100_000_001, currency: "zar", lineItems: [], chargeId: CHARGE, carryOutCents: 0, carriedInCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09", createdAt: new Date(2026, 8, 20) });
    const out = await runUsageClose(NOW);
    expect(out).toMatchObject({ failed: 0, refusals: [{ reason: expect.stringMatching(/^over ceiling:/) }] });
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(0);
    expect(frozen()).toMatchObject({ withheldReason: "over ceiling" });
    expect(frozen()?.withheldAt).toBeDefined();
    expect(await events("usage.withheld")).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ reason: "over ceiling", chargeCanceled: false }) }),
    ]);
    expect((await runUsageClose(NOW)).refusals).toEqual([]);
  });

  it("the ceiling itself is accepted", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-09", {
      closed: { totalCents: 100_000_000, currency: "zar", lineItems: [], chargeId: CHARGE, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    expect((await runUsageClose(NOW)).charged).toBe(1);
  });
});

describe("the pay-link token secret", () => {
  it.each([["unset", ""], ["too short", "short"]])("%s: the charge is not even created, it is a refusal, and nothing is a daily 500", async (_l, value) => {
    spyBillingProvider("stripe");
    vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", value);
    const out = await runUsageClose(NOW);
    expect(out).toMatchObject({ failed: 0, refusals: [{ subAccountId: "sa1", reason: expect.stringMatching(/token secret not configured/) }] });
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(1);
    vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "x".repeat(32));
    expect((await runUsageClose(NOW)).charged).toBe(1);
  });

  it("a reminder with the secret gone is a refusal that keeps its stage", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, dueAt: new Date(2026, 9, 15, 12, 0) });
    vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "");
    const out = await runUsageClose(new Date(2026, 9, 12, 5, 0));
    expect(out).toMatchObject({ failed: 0, reminded: 0, refusals: [{ reason: expect.stringMatching(/token secret not configured/) }] });
    expect(mem.read(`billingCharges/${CHARGE}`)?.remindedAt).toEqual({});
  });
});

describe("nobody to email", () => {
  it("Stripe: the charge exists, the entry stays queued, and a contact set later gets the invoice", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    const first = await runUsageClose(NOW);
    expect(first).toMatchObject({ charged: 1, failed: 0 });
    expect(first.refusals).toEqual([
      { subAccountId: "sa1", month: "2026-09", reason: expect.stringMatching(/no one to email the invoice to/) },
    ]);
    expect(mail.send).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(1);
    expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({ emailedTo: null, tokenHash: null });
    expect(mem.read(`billingCharges/${CHARGE}`)?.invoiceEmailClaimedAt).toBeUndefined();

    mem.seed("subAccounts/sa1", SUB);
    const second = await runUsageClose(new Date(NOW.getTime() + 86_400_000));
    expect(second.charged).toBe(0);
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mem.read(`billingCharges/${CHARGE}`)?.emailedTo).toBe(EMAIL);
    expect(queue()).toHaveLength(0);
    expect(charges()).toHaveLength(1);
  });

  it("a reminder with no recipient does not use up its stage", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    const doc = mem.read(`billingCharges/${CHARGE}`)!;
    mem.seed(`billingCharges/${CHARGE}`, { ...doc, dueAt: new Date(2026, 9, 15, 12, 0) });
    mail.send.mockClear();
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    expect((await runUsageClose(new Date(2026, 9, 12, 5, 0))).reminded).toBe(0);
    expect(mem.read(`billingCharges/${CHARGE}`)?.remindedAt).toEqual({});
    mem.seed("subAccounts/sa1", SUB);
    expect((await runUsageClose(new Date(2026, 9, 13, 5, 0))).reminded).toBe(1);
  });
});
