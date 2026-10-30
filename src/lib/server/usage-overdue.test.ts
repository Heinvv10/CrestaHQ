import { describe, expect, it, vi } from "vitest";
import { spyBillingProvider } from "@/test/billing-provider-spies";
import { CHARGE, NOW, charges, mail, mem, setupUsageBillingTests } from "@/test/usage-billing-harness";

/**
 * `subAccounts/{id}.usageOverdue`: when the flag exists, what clears it, and
 * that it fails open. Real close, real billing-service and lifecycle, in-memory
 * Firestore; only the mail transport is a spy. Shared setup:
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
const { refreshUsageOverdue, sweepUsageOverdue } = await import("./usage-overdue");
const { cancelOneTimeCharge } = await import("./billing-service");
const { markSubAccountChargePaid } = await import("./billing-lifecycle");
const { setClientUsageRebilling, setAgencyUsageRebilling, setAgencyUsagePaywall } = await import("./usage-rebilling");

setupUsageBillingTests();

/** The close ran on the 1st; the invoice is due 14 days later. */
const DUE_DAY = new Date(2026, 9, 15, 5, 0);
const ON_DUE_DAY = new Date(2026, 9, 15, 23, 0);
const DAY_AFTER = new Date(2026, 9, 16, 5, 0);

const flag = () => mem.read("subAccounts/sa1")?.usageOverdue as Record<string, unknown> | null | undefined;
const setCharge = (patch: Record<string, unknown>) =>
  mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, ...patch });
const agency = (patch: Record<string, unknown>) => mem.seed("agencies/ag1", { ...mem.read("agencies/ag1")!, ...patch });
const sub = (patch: Record<string, unknown>) => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, ...patch });

async function emailedCharge() {
  spyBillingProvider("stripe");
  await runUsageClose(NOW);
  expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({ status: "pending", emailedTo: expect.any(String) });
}

describe("when the flag exists", () => {
  it("flags an emailed, pending usage charge once its due DAY has passed, not on the day", async () => {
    await emailedCharge();
    await refreshUsageOverdue("sa1", ON_DUE_DAY);
    expect(flag()).toBeFalsy();
    await refreshUsageOverdue("sa1", DAY_AFTER);
    expect(flag()).toMatchObject({
      chargeId: CHARGE,
      amountCents: 5000,
      currency: "zar",
      usageMonth: "2026-09",
      paywall: false,
    });
  });

  it("a charge that was never emailed is not flagged", async () => {
    await emailedCharge();
    setCharge({ emailedTo: null });
    await refreshUsageOverdue("sa1", DAY_AFTER);
    expect(flag()).toBeFalsy();
  });

  it("a manual charge, a paid one and a waived one are not flagged", async () => {
    await emailedCharge();
    for (const patch of [{ kind: "manual" }, { status: "paid" }, { status: "canceled" }]) {
      setCharge({ kind: "usage", status: "pending", ...patch });
      await refreshUsageOverdue("sa1", DAY_AFTER);
      expect(flag()).toBeFalsy();
    }
  });

  it("points at the oldest of several overdue charges", async () => {
    await emailedCharge();
    mem.seed("billingCharges/usage_sa1_2026-08", {
      ...mem.read(`billingCharges/${CHARGE}`)!,
      id: "usage_sa1_2026-08",
      usageMonth: "2026-08",
      dueAt: new Date(2026, 8, 15, 12, 0),
    });
    await refreshUsageOverdue("sa1", DAY_AFTER);
    expect(flag()?.chargeId).toBe("usage_sa1_2026-08");
  });

  it("carries the agency's paywall setting, and a change to it updates a standing flag", async () => {
    await emailedCharge();
    await refreshUsageOverdue("sa1", DAY_AFTER);
    expect(flag()?.paywall).toBe(false);
    agency({ usagePaywallEnabled: true });
    await refreshUsageOverdue("sa1", DAY_AFTER);
    expect(flag()?.paywall).toBe(true);
    agency({ usagePaywallEnabled: "yes" });
    await refreshUsageOverdue("sa1", DAY_AFTER);
    expect(flag()?.paywall).toBe(false);
  });
});

describe("stays dark: a workspace with a switch off is never flagged, so never walled", () => {
  it.each([
    ["the client switch", () => sub({ usageRebillingEnabled: false })],
    ["the agency switch", () => agency({ usageRebillingEnabled: false })],
    ["a client switch that is not exactly true", () => sub({ usageRebillingEnabled: "true" })],
  ])("%s is off and the charge is overdue", async (_name, switchOff) => {
    await emailedCharge();
    agency({ usagePaywallEnabled: true });
    switchOff();
    await refreshUsageOverdue("sa1", DAY_AFTER);
    expect(flag()).toBeFalsy();
  });

  it("turning a switch off lifts a standing flag at once", async () => {
    await emailedCharge();
    agency({ usagePaywallEnabled: true });
    await refreshUsageOverdue("sa1", DAY_AFTER);
    expect(flag()).toBeTruthy();
    await setClientUsageRebilling("sa1", false, "own");
    expect(flag()).toBeNull();
  });

  it("the agency master switch going off lifts every standing flag", async () => {
    await emailedCharge();
    await refreshUsageOverdue("sa1", DAY_AFTER);
    expect(flag()).toBeTruthy();
    await setAgencyUsageRebilling("ag1", false, "own");
    expect(flag()).toBeNull();
  });
});

describe("what clears it", () => {
  it("a paid charge clears the flag, and a redelivery of the payment does too", async () => {
    await emailedCharge();
    await refreshUsageOverdue("sa1", DAY_AFTER);
    expect(flag()).toBeTruthy();
    await markSubAccountChargePaid({ chargeId: CHARGE, checkoutSessionId: "cs_1", paymentId: "pi_1" });
    expect(charges()[0].status).toBe("paid");
    expect(flag()).toBeNull();

    // A flag a failed refresh left behind is cleared by the redelivery.
    sub({ usageOverdue: { chargeId: CHARGE, since: new Date(), amountCents: 5000, currency: "zar", usageMonth: "2026-09", paywall: true } });
    await markSubAccountChargePaid({ chargeId: CHARGE, checkoutSessionId: "cs_1", paymentId: "pi_1" });
    expect(flag()).toBeNull();
  });

  it("waiving the charge clears the flag", async () => {
    await emailedCharge();
    await refreshUsageOverdue("sa1", DAY_AFTER);
    expect(flag()).toBeTruthy();
    await cancelOneTimeCharge({ agencyId: "ag1", chargeId: CHARGE });
    expect(flag()).toBeNull();
  });

  it("turning the paywall setting off or on re-checks a standing flag and audits the change", async () => {
    await emailedCharge();
    agency({ usagePaywallEnabled: true });
    await refreshUsageOverdue("sa1", DAY_AFTER);
    expect(flag()?.paywall).toBe(true);
    expect(await setAgencyUsagePaywall("ag1", false, "own")).toEqual({ changed: true });
    expect(flag()?.paywall).toBe(false);
    expect(await setAgencyUsagePaywall("ag1", false, "own")).toEqual({ changed: false });
    expect(mem.list("auditEvents").filter((r) => r.action === "usage_paywall.updated")).toHaveLength(1);
  });

  it("the daily sweep flags a charge that has just gone overdue and clears a stale flag", async () => {
    await emailedCharge();
    expect(await sweepUsageOverdue(DAY_AFTER)).toBe(1);
    expect(flag()).toBeTruthy();
    setCharge({ status: "paid" });
    await sweepUsageOverdue(DAY_AFTER);
    expect(flag()).toBeNull();
  });

  it("the daily close runs the sweep", async () => {
    await emailedCharge();
    await runUsageClose(DAY_AFTER);
    expect(flag()).toMatchObject({ chargeId: CHARGE });
  });
});

describe("fails open: a read error never walls", () => {
  it("an error during the refresh never sets a flag", async () => {
    await emailedCharge();
    agency({ usagePaywallEnabled: true });
    vi.spyOn(mem.db, "runTransaction").mockRejectedValueOnce(new Error("firestore unavailable"));
    await expect(refreshUsageOverdue("sa1", DAY_AFTER)).resolves.toBeUndefined();
    expect(flag()).toBeFalsy();
  });

  it("an error during the refresh clears a standing flag instead of keeping the wall", async () => {
    await emailedCharge();
    agency({ usagePaywallEnabled: true });
    await refreshUsageOverdue("sa1", DAY_AFTER);
    expect(flag()?.paywall).toBe(true);
    vi.spyOn(mem.db, "runTransaction").mockRejectedValueOnce(new Error("firestore unavailable"));
    await refreshUsageOverdue("sa1", DAY_AFTER);
    expect(flag()).toBeNull();
  });

  it("a failure of the whole sweep is swallowed", async () => {
    vi.spyOn(mem.db, "collection").mockImplementationOnce(() => {
      throw new Error("firestore unavailable");
    });
    await expect(sweepUsageOverdue(DAY_AFTER)).resolves.toBe(0);
  });
});

describe("the due date is the one the close wrote", () => {
  it("DUE_DAY fixture is 14 days after the close", async () => {
    await emailedCharge();
    const due = mem.read(`billingCharges/${CHARGE}`)?.dueAt as { toMillis(): number } | Date;
    const ms = due instanceof Date ? due.getTime() : due.toMillis();
    expect(new Date(ms).getDate()).toBe(DUE_DAY.getDate());
  });
});
