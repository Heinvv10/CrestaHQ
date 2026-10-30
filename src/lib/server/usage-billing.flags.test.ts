import { afterEach, describe, expect, it, vi } from "vitest";
import { spyBillingProvider } from "@/test/billing-provider-spies";
import { CHARGE, NOW, SUB, charges, events, frozen, mail, mem, queue, setupUsageBillingTests } from "@/test/usage-billing-harness";

/**
 * A month that needs a person raises ONE `usage.flagged` row (listed under
 * Agency -> Client billing -> Attention, no email) on the first day it
 * appears, however many daily runs repeat it. Shared setup:
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
const notify = vi.hoisted(() => ({ notifyFlag: vi.fn(async () => {}) }));
vi.mock("@/lib/server/billing-attention-notify", () => notify);

const { runUsageClose } = await import("./usage-billing-service");
const { listAgencyBillingFlags, resolveAgencyBillingFlag } = await import("@/lib/server/billing-attention");
const { isoWeekKey } = await import("./usage-billing-flags");

setupUsageBillingTests();

const flags = async () => (await events("usage.flagged")).map((e) => e.detail as { reason: string; reference: string | null; month: string | null });
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const LATER = () => new Date(Date.now() + 8 * 86_400_000);

describe("a refusal is flagged once, not daily", () => {
  it("Paystack with no email: one flag over three days, listed under Attention, never emailed", async () => {
    spyBillingProvider("paystack");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    for (const n of [0, 1, 2]) expect((await runUsageClose(day(n))).refusals).toHaveLength(1);
    expect(await flags()).toEqual([
      expect.objectContaining({ reason: expect.stringMatching(/Paystack needs an email/), reference: CHARGE, month: "2026-09" }),
    ]);
    const listed = await listAgencyBillingFlags("ag1");
    expect(listed).toEqual([
      expect.objectContaining({ subAccountId: "sa1", reference: CHARGE, reason: expect.stringMatching(/Paystack needs an email/) }),
    ]);
    expect(notify.notifyFlag).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("a different reason for the same month is a new flag; a resolved one stays resolved", async () => {
    spyBillingProvider("paystack");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    await runUsageClose(NOW);
    const [first] = await listAgencyBillingFlags("ag1");
    expect(await resolveAgencyBillingFlag("ag1", first.flagId, { uid: "own", email: "o@x.co" })).toBe(true);
    await runUsageClose(day(1));
    expect(await listAgencyBillingFlags("ag1")).toEqual([]);

    mem.seed("subAccounts/sa1", SUB);
    vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "");
    await runUsageClose(day(2));
    expect(await flags()).toHaveLength(2);
    expect(await listAgencyBillingFlags("ag1")).toEqual([
      expect.objectContaining({ reason: expect.stringMatching(/token secret not configured/) }),
    ]);
  });

  it("a reminder with nobody to remind is a refusal (not a silent return), flagged once", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, dueAt: new Date(2026, 9, 15, 12, 0) });
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    for (const d of [12, 13]) {
      const out = await runUsageClose(new Date(2026, 9, d, 5, 0));
      expect(out).toMatchObject({ failed: 0, reminded: 0, refusals: [{ reason: expect.stringMatching(/^no recipient to send the reminder to/) }] });
    }
    expect(await flags()).toHaveLength(1);
    expect(mem.read(`billingCharges/${CHARGE}`)?.remindedAt).toEqual({});
  });
});

describe("a withhold is flagged", () => {
  it("Paystack with no email for 7 days: the month is withheld as 'no billing email', flagged, and never billed later", async () => {
    spyBillingProvider("paystack");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    await runUsageClose(NOW);
    expect(queue()).toHaveLength(1);
    expect(frozen()?.withheldAt).toBeUndefined();

    const out = await runUsageClose(LATER());
    expect(out).toMatchObject({ failed: 0, refusals: [{ reason: expect.stringMatching(/^no billing email for 7 days/) }] });
    expect(frozen()).toMatchObject({ withheldReason: "no billing email" });
    expect(queue()).toHaveLength(0);
    expect(charges()).toHaveLength(0);
    expect(await events("usage.withheld")).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ reason: "no billing email", chargeCanceled: false }) }),
    ]);
    expect((await flags()).filter((f) => /not billed/.test(f.reason))).toEqual([
      expect.objectContaining({ reason: expect.stringMatching(/not billed \(no billing email\)/) }),
    ]);

    // Fixing it months later does not bill the old month.
    mem.seed("subAccounts/sa1", SUB);
    expect(await runUsageClose(day(60))).toMatchObject({ charged: 0, refusals: [] });
    expect(charges()).toHaveLength(0);
  });

  it("a switch-off cancels the unsent charge and flags it", async () => {
    spyBillingProvider("stripe");
    mail.send.mockRejectedValueOnce(new Error("smtp down"));
    await runUsageClose(NOW);
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });
    await runUsageClose(day(1));
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("canceled");
    expect((await flags()).filter((f) => /not billed/.test(f.reason))).toEqual([
      expect.objectContaining({ reason: expect.stringMatching(/not billed \(rebilling_switched_off_before_invoice\); its charge was cancelled/) }),
    ]);
  });

  it("an invoice unsent for 7 days is cancelled and flagged once (the refusal does not flag twice)", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    await runUsageClose(NOW);
    await runUsageClose(LATER());
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("canceled");
    const all = await flags();
    expect(all.filter((f) => /not billed/.test(f.reason))).toHaveLength(1);
    // The follow-on refusal reuses that flag; it adds none of its own.
    expect(all.filter((f) => /within 7 days/.test(f.reason))).toHaveLength(0);
  });
});

describe("a send of unknown state is not dropped silently", () => {
  it("attempted but never confirmed after 7 days: reported, flagged, the charge left as it is", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    mem.seed(`billingCharges/${CHARGE}`, {
      ...mem.read(`billingCharges/${CHARGE}`)!, emailedTo: null, invoiceEmailClaimedAt: undefined,
      emailAttemptedAt: new Date(),
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    const out = await runUsageClose(LATER());
    expect(out).toMatchObject({
      failed: 0,
      refusals: [{ reason: expect.stringMatching(/send state is unknown.*check the charge usage_sa1_2026-09/) }],
    });
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("pending");
    expect(frozen()?.withheldAt).toBeUndefined();
    expect(queue()).toHaveLength(0);
    expect(await flags()).toEqual([expect.objectContaining({ reason: expect.stringMatching(/send state is unknown/) })]);
  });
});

describe("a problem that recurs after it was resolved flags again, once per ISO week", () => {
  afterEach(() => vi.useRealTimers());
  const at = (iso: string) => vi.setSystemTime(new Date(iso));

  it("isoWeekKey follows ISO 8601 across year boundaries", () => {
    expect(isoWeekKey(new Date("2026-10-12T00:00:00Z"))).toBe("2026-W42");
    expect(isoWeekKey(new Date("2026-10-18T23:59:59Z"))).toBe("2026-W42");
    expect(isoWeekKey(new Date("2026-10-19T00:00:00Z"))).toBe("2026-W43");
    expect(isoWeekKey(new Date("2026-01-01T12:00:00Z"))).toBe("2026-W01");
    expect(isoWeekKey(new Date("2024-12-30T12:00:00Z"))).toBe("2025-W01");
    expect(isoWeekKey(new Date("2021-01-03T12:00:00Z"))).toBe("2020-W53");
  });

  it("resolved in week 42, back in week 43: a new flag; further days of that week add none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    spyBillingProvider("paystack");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });

    at("2026-10-12T08:00:00Z");
    await runUsageClose(day(0));
    at("2026-10-14T08:00:00Z");
    await runUsageClose(day(1));
    expect(await flags()).toHaveLength(1);

    const [first] = await listAgencyBillingFlags("ag1");
    expect(await resolveAgencyBillingFlag("ag1", first.flagId, { uid: "own", email: "o@x.co" })).toBe(true);
    at("2026-10-16T08:00:00Z");
    await runUsageClose(day(2));
    expect(await listAgencyBillingFlags("ag1")).toEqual([]);

    at("2026-10-19T08:00:00Z");
    await runUsageClose(day(3));
    expect(await listAgencyBillingFlags("ag1")).toHaveLength(1);
    at("2026-10-21T08:00:00Z");
    await runUsageClose(day(4));
    expect(await flags()).toHaveLength(2);
    expect(await listAgencyBillingFlags("ag1")).toHaveLength(1);
  });
});
