import { describe, expect, it, vi } from "vitest";
import { spyBillingProvider } from "@/test/billing-provider-spies";
import { CHARGE, NOW, SUB, charges, events, frozen, mail, mem, queue, setupUsageBillingTests } from "@/test/usage-billing-harness";

/**
 * No month stays held for more than about a week, so a carry restored by a late
 * withhold always reaches the next close; and a charge paid or cancelled while
 * its email goes out is done, not a refusal. Shared setup:
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

const { freezeMonthForSubAccount, runUsageClose } = await import("./usage-billing-service");

setupUsageBillingTests();

const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const flags = async () => (await events("usage.flagged")).map((e) => e.detail as { reason: string });

describe("a held month is withheld within the window, whatever held it", () => {
  /** August left 300c; September (5,000c) froze with it at NOW and is held by an unset token secret. */
  const heldSeptember = async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-08", {
      closed: { totalCents: 300, currency: "zar", lineItems: [], chargeId: null, carryOutCents: 300 },
    });
    await freezeMonthForSubAccount({ sub: { ...SUB, id: "sa1" } as never, month: "2026-09" });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09", createdAt: NOW });
    vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "");
  };

  it("held for a week by a config fault, then withheld: the carry still reaches the next billed month", async () => {
    await heldSeptember();
    for (let n = 0; n <= 6; n++) expect((await runUsageClose(day(n))).refusals).toHaveLength(1);
    expect(frozen()?.withheldAt).toBeUndefined();

    const out = await runUsageClose(day(8));
    expect(out).toMatchObject({ failed: 0, refusals: [{ reason: expect.stringMatching(/^charge could not be created for 7 days/) }] });
    expect(frozen()).toMatchObject({ withheldReason: "charge could not be created", carryOutCents: 300 });
    expect(queue()).toHaveLength(0);
    expect(charges()).toHaveLength(0);
    expect(await flags()).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringMatching(/not billed \(charge could not be created\)/) })]));

    // October closes on 1 November: September's restored carry is picked up, not orphaned.
    vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "x".repeat(32));
    mem.seed("subAccounts/sa1/usage/2026-10", { emailsSent: 130 });
    await runUsageClose(new Date(2026, 10, 1, 5, 0));
    expect(frozen("2026-10")).toMatchObject({ carriedInCents: 300, totalCents: 600 });
    expect(mem.read("billingCharges/usage_sa1_2026-10")).toMatchObject({ amountCents: 600 });
  });

  it("no queued entry is ever older than the window plus a day when the next month closes", async () => {
    await heldSeptember();
    for (let n = 0; n <= 9; n++) await runUsageClose(day(n));
    expect(queue()).toHaveLength(0);
  });

  it("a refusal inside the window is still held, not withheld", async () => {
    await heldSeptember();
    await runUsageClose(day(5));
    expect(frozen()?.withheldAt).toBeUndefined();
    expect(queue()).toHaveLength(1);
  });
});

describe("a charge paid or cancelled while its email goes out", () => {
  it("invoice: sent, done and quiet (no refusal, no flag, entry cleared)", async () => {
    spyBillingProvider("stripe");
    mail.send.mockImplementationOnce(async () => {
      mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, status: "paid", tokenHash: null });
      return {};
    });
    const out = await runUsageClose(NOW);
    expect(out).toMatchObject({ failed: 0, refusals: [] });
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({ status: "paid", tokenHash: null });
    expect(queue()).toHaveLength(0);
    expect(await flags()).toEqual([]);
  });

  it("reminder: sent, the stage used, quiet", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, dueAt: new Date(2026, 9, 15, 12, 0) });
    mail.send.mockImplementationOnce(async () => {
      mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, status: "canceled", tokenHash: null });
      return {};
    });
    const out = await runUsageClose(new Date(2026, 9, 12, 5, 0));
    expect(out).toMatchObject({ failed: 0, reminded: 1, refusals: [] });
    expect(mem.read(`billingCharges/${CHARGE}`)?.remindedAt).toHaveProperty("beforeDue");
    expect(await flags()).toEqual([]);
  });
});
