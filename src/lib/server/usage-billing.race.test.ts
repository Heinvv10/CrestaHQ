import { describe, expect, it, vi } from "vitest";
import { spyBillingProvider } from "@/test/billing-provider-spies";
import { CHARGE, NOW, SUB, charges, frozen, mail, mem, setupUsageBillingTests } from "@/test/usage-billing-harness";

/**
 * A mint racing a withhold: either the mint sees the withhold stamp (and does
 * not mint) or the withhold sees the charge (and cancels it). Never a month
 * stamped withheld, with its carry written back, that also has a live charge.
 * Does not rely on one process: both sides are transactions. Shared setup:
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

const { withholdUnsent } = await import("./usage-billing-withhold");
const { createUsageCharge } = await import("./billing-service");

setupUsageBillingTests();

const LEDGER = "subAccounts/sa1/usage/2026-09";
const CHARGE_PATH = `billingCharges/${CHARGE}`;
const sub = { ...SUB, id: "sa1" } as never;

const seedFrozen = () =>
  mem.seed(LEDGER, {
    emailsSent: 600,
    closed: { totalCents: 5300, currency: "zar", lineItems: [], chargeId: CHARGE, carriedInCents: 300, carryOutCents: 0 },
  });
const mint = () =>
  createUsageCharge({
    agencyId: "ag1", subAccountId: "sa1", month: "2026-09", description: "Usage", amountCents: 5300,
    currency: "zar", lineItems: [], dueAt: new Date(2026, 9, 15), payerEmail: "client@example.com", ledgerPath: LEDGER,
  });
const withhold = () =>
  withholdUnsent({ sub, month: "2026-09", chargeId: CHARGE, now: NOW, ledgerRef: mem.db.doc(LEDGER) as never, carryBackCents: 300 });
const pending = () => mem.read(CHARGE_PATH)?.status === "pending";
const withheld = () => frozen()?.withheldAt !== undefined;
/** mulberry32: a fixed seed makes the interleavings, and so the test, repeatable. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ticks = (n: number) => new Promise<void>((r) => { let i = 0; const go = () => (i++ >= n ? r() : setImmediate(go)); go(); });

describe("a mint and a withhold never both win", () => {
  it("a month already withheld is not minted", async () => {
    spyBillingProvider("stripe");
    seedFrozen();
    expect(await withhold()).toBe("withheld");
    expect(await mint()).toMatchObject({ created: false, withheld: true });
    expect(charges()).toHaveLength(0);
    expect(frozen()).toMatchObject({ carryOutCents: 300 });
  });

  it("a charge minted first is seen by the withhold and cancelled with the stamp", async () => {
    spyBillingProvider("stripe");
    seedFrozen();
    expect(await mint()).toMatchObject({ created: true });
    expect(await withhold()).toBe("withheld");
    expect(mem.read(CHARGE_PATH)).toMatchObject({ status: "canceled" });
    expect(withheld()).toBe(true);
  });

  it("a charge that lands in the middle of the withhold's transaction makes it retry and see the charge", async () => {
    spyBillingProvider("stripe");
    seedFrozen();
    const real = mem.db.runTransaction.bind(mem.db);
    let injected = false;
    let attempts = 0;
    const tx = vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn: Parameters<typeof real>[0]) =>
      real(async (t) => {
        attempts++;
        return fn(
          new Proxy(t, {
            get: (o, k) =>
              k === "get"
                ? async (ref: { path: string }) => {
                    const snap = await (o.get as (r: unknown) => Promise<unknown>)(ref);
                    if (!injected && ref.path === CHARGE_PATH) {
                      injected = true;
                      await mint();
                    }
                    return snap;
                  }
                : Reflect.get(o, k),
          }),
        );
      }),
    );
    expect(await withhold()).toBe("withheld");
    tx.mockRestore();
    expect(attempts).toBeGreaterThan(1);
    expect(mem.read(CHARGE_PATH)).toMatchObject({ status: "canceled" });
    expect(withheld()).toBe(true);
  });

  it("a mint landing between a read and a separate ledger write cannot leave a live charge under a withheld month", async () => {
    spyBillingProvider("stripe");
    seedFrozen();
    // Any direct write to the ledger doc (outside a transaction) is preceded by a mint.
    const realDoc = mem.db.doc.bind(mem.db);
    let injected = false;
    const spy = vi.spyOn(mem.db, "doc").mockImplementation(((path: string) => {
      const ref = realDoc(path);
      if (path !== LEDGER) return ref;
      return new Proxy(ref, {
        get: (o, k) =>
          k === "update"
            ? async (...a: unknown[]) => {
                if (!injected) { injected = true; await mint(); }
                return (o.update as (...x: unknown[]) => unknown)(...a);
              }
            : Reflect.get(o, k),
      });
    }) as never);
    await withhold();
    spy.mockRestore();
    expect(withheld() && pending()).toBe(false);
  });

  it("40 interleaved races (fixed seed) never leave a withheld month with a live charge", async () => {
    spyBillingProvider("stripe");
    const outcomes = new Set<string>();
    const random = prng(20261001);
    for (let i = 0; i < 40; i++) {
      mem.clear();
      mem.seed("agencies/ag1", { ownerUid: "own", usageRebillingEnabled: true });
      mem.seed("subAccounts/sa1", SUB);
      seedFrozen();
      const [a, b] = [Math.floor(random() * 6), Math.floor(random() * 6)];
      await Promise.all([ticks(a).then(mint), ticks(b).then(withhold)]);
      expect(withheld() && pending()).toBe(false);
      expect(withheld()).toBe(true);
      outcomes.add(mem.read(CHARGE_PATH) ? "charge cancelled" : "never minted");
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });
});
