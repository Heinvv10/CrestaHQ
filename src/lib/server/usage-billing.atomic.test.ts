import { describe, expect, it, vi } from "vitest";
import { spyBillingProvider } from "@/test/billing-provider-spies";
import { CHARGE, NOW, SUB, charges, events, frozen, mail, mem, queue, setupUsageBillingTests } from "@/test/usage-billing-harness";

/**
 * A charge cancel and the withheld ledger are ONE commit: a crash right after
 * the cancel cannot lose the carry or leave a cancelled charge on a month that
 * was never marked withheld. Shared setup: src/test/usage-billing-harness.ts.
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
const { announceWithheld } = await import("./usage-billing-withhold");

setupUsageBillingTests();

type TxFn = Parameters<typeof mem.db.runTransaction>[0];

/** The next runTransaction commits, then the process "dies" before anything after it runs. */
function crashAfterNextCommit() {
  const real = mem.db.runTransaction.bind(mem.db);
  return vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn: TxFn) => {
    await real(fn);
    throw new Error("process died after commit");
  });
}

/** August carried 300c into September, which is then frozen (and so owes it). */
const frozenWithCarry = async () => {
  mem.seed("subAccounts/sa1/usage/2026-08", {
    closed: { totalCents: 300, currency: "zar", lineItems: [], chargeId: null, carryOutCents: 300 },
  });
  await freezeMonthForSubAccount({ sub: { ...SUB, id: "sa1" } as never, month: "2026-09" });
};

describe("cancel + withheld ledger in one commit", () => {
  it("switch-off cancel: a crash right after it leaves the ledger withheld with the carry, and the retry changes nothing", async () => {
    spyBillingProvider("stripe");
    await frozenWithCarry();
    mail.send.mockRejectedValueOnce(new Error("smtp down"));
    await runUsageClose(NOW); // charge minted, invoice not sent
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });

    const tx = crashAfterNextCommit();
    const out = await runUsageClose(NOW);
    tx.mockRestore();
    expect(out.failed).toBe(1);
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("canceled");
    expect(frozen()).toMatchObject({ withheldReason: "rebilling_switched_off_before_invoice", carryOutCents: 300 });
    expect(frozen()?.withheldAt).toBeDefined();

    await runUsageClose(NOW);
    expect(queue()).toHaveLength(0);
    expect(charges()).toHaveLength(1);
    expect(frozen()).toMatchObject({ carryOutCents: 300 });
  });

  it("7-day expiry cancel: same guarantee", async () => {
    spyBillingProvider("stripe");
    await frozenWithCarry();
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    await runUsageClose(NOW); // charge minted, nobody to email
    const later = new Date(Date.now() + 8 * 86_400_000);

    const tx = crashAfterNextCommit();
    const out = await runUsageClose(later);
    tx.mockRestore();
    expect(out.failed).toBe(1);
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("canceled");
    expect(frozen()).toMatchObject({ withheldReason: "invoice could not be sent", carryOutCents: 300 });
    expect(frozen()?.withheldAt).toBeDefined();
  });

  it("a write that fails inside the transaction commits neither half", async () => {
    spyBillingProvider("stripe");
    await frozenWithCarry();
    mail.send.mockRejectedValueOnce(new Error("smtp down"));
    await runUsageClose(NOW);
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });

    const real = mem.db.runTransaction.bind(mem.db);
    const tx = vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn: TxFn) =>
      real((t) =>
        fn(
          new Proxy(t, {
            get: (o, k) =>
              k === "update"
                ? (ref: { path: string }, ...a: unknown[]) => {
                    if (ref.path.includes("/usage/")) throw new Error("ledger write failed");
                    return (o.update as (...x: unknown[]) => unknown)(ref, ...a);
                  }
                : Reflect.get(o, k),
          }),
        ),
      ),
    );
    const out = await runUsageClose(NOW);
    tx.mockRestore();
    expect(out.failed).toBe(1);
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("pending");
    expect(frozen()?.withheldAt).toBeUndefined();
  });
});

describe("the announce survives a crash between the commit and itself", () => {
  const withholdAudit = async () => ({
    withheld: await events("usage.withheld"),
    canceled: await events("charge.canceled"),
    flags: (await events("usage.flagged")).filter((e) => /not billed/.test((e.detail as { reason: string }).reason)),
  });

  it("a cancelled charge: the retry writes exactly one audit set and one flag, and later runs add none", async () => {
    spyBillingProvider("stripe");
    mail.send.mockRejectedValueOnce(new Error("smtp down"));
    await runUsageClose(NOW); // charge minted, invoice not sent
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });

    const tx = crashAfterNextCommit();
    expect((await runUsageClose(NOW)).failed).toBe(1);
    tx.mockRestore();
    expect(await withholdAudit()).toMatchObject({ withheld: [], canceled: [], flags: [] });
    expect(queue()).toHaveLength(1);

    for (let i = 0; i < 3; i++) await runUsageClose(NOW);
    const audit = await withholdAudit();
    expect(audit.withheld).toHaveLength(1);
    expect(audit.canceled).toHaveLength(1);
    expect(audit.flags).toHaveLength(1);
    expect(queue()).toHaveLength(0);
  });

  it("no charge at all: the retry does not duplicate the rows or the flag", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-09", {
      closed: { totalCents: 5000, currency: "zar", lineItems: [], chargeId: CHARGE, carriedInCents: 0, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });

    const tx = crashAfterNextCommit();
    expect((await runUsageClose(NOW)).failed).toBe(1);
    tx.mockRestore();
    for (let i = 0; i < 3; i++) await runUsageClose(NOW);
    const audit = await withholdAudit();
    expect(audit.withheld).toHaveLength(1);
    expect(audit.canceled).toHaveLength(0);
    expect(audit.flags).toHaveLength(1);
    expect(charges()).toHaveLength(0);
  });

  it("announcing the same withhold twice (even in different weeks) writes one set", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const input = {
      sub: { ...SUB, id: "sa1" } as never, month: "2026-09", chargeId: CHARGE, charge: "canceled" as const,
      why: "invoice could not be sent", carryBackCents: 0,
    };
    vi.setSystemTime(new Date("2026-10-12T08:00:00Z"));
    await announceWithheld(input);
    vi.setSystemTime(new Date("2026-10-21T08:00:00Z"));
    await announceWithheld(input);
    vi.useRealTimers();
    const audit = await withholdAudit();
    expect([audit.withheld.length, audit.canceled.length, audit.flags.length]).toEqual([1, 1, 1]);
  });

  it("a flag that fails to write fails the run and keeps the entry; the retry writes it once", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-09", {
      closed: { totalCents: 5000, currency: "zar", lineItems: [], chargeId: CHARGE, carriedInCents: 0, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });

    const realCollection = mem.db.collection.bind(mem.db);
    const spy = vi.spyOn(mem.db, "collection").mockImplementation(((name: string) => {
      const col = realCollection(name);
      if (name !== "billingEvents") return col;
      return new Proxy(col, {
        get: (o, k) =>
          k === "doc"
            ? (id: string) => {
                const ref = (o.doc as (i: string) => object)(id);
                return id.startsWith("usage-flag-")
                  ? new Proxy(ref, { get: (r, key) => (key === "create" ? () => Promise.reject(new Error("UNAVAILABLE")) : Reflect.get(r, key)) })
                  : ref;
              }
            : Reflect.get(o, k),
      });
    }) as never);
    expect((await runUsageClose(NOW)).failed).toBe(1);
    spy.mockRestore();
    expect(queue()).toHaveLength(1);
    await runUsageClose(NOW);
    expect(queue()).toHaveLength(0);
    const audit = await withholdAudit();
    expect([audit.withheld.length, audit.flags.length]).toEqual([1, 1]);
  });

  it("a mint that loses the race to a withhold announces it, even if the winner died before it could", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-09", {
      closed: { totalCents: 5000, currency: "zar", lineItems: [], chargeId: CHARGE, carriedInCents: 0, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    // The mint's transaction is the first one; the "other run" stamps the withhold just before it.
    const real = mem.db.runTransaction.bind(mem.db);
    const tx = vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn: TxFn) => {
      mem.seed("subAccounts/sa1/usage/2026-09", {
        closed: {
          totalCents: 5000, currency: "zar", lineItems: [], chargeId: CHARGE, carriedInCents: 0, carryOutCents: 0,
          withheldAt: new Date(), withheldReason: "rebilling_switched_off_before_invoice",
        },
      });
      return real(fn);
    });
    await runUsageClose(NOW);
    tx.mockRestore();
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(0);
    const audit = await withholdAudit();
    expect([audit.withheld.length, audit.flags.length]).toEqual([1, 1]);
  });

  it("the audit rows carry deterministic ids", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-09", {
      closed: { totalCents: 5000, currency: "zar", lineItems: [], chargeId: CHARGE, carriedInCents: 0, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });
    await runUsageClose(NOW);
    expect(mem.read("billingEvents/usage-withheld-sa1-2026-09")).toMatchObject({ event: "usage.withheld" });
  });
});
