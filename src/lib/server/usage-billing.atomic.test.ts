import { describe, expect, it, vi } from "vitest";
import { spyBillingProvider } from "@/test/billing-provider-spies";
import { CHARGE, NOW, SUB, charges, frozen, mail, mem, queue, setupUsageBillingTests } from "@/test/usage-billing-harness";

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
