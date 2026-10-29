import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askAgency, confirmAgency, lookupResult, mem, seedTenants } from "@/test/chat-route-harness";
import { restoreBillingProviderAfterEach, spyBillingProvider } from "@/test/billing-provider-spies";
import { usageMonthKey } from "@/lib/server/usage-meter";
import { formatBillingPrice } from "@/lib/billing/status";

/**
 * N2b's usage tools through the real Agency Assistant chat and confirm
 * routes (an owner of ag1): sub_account_usage reports this month's ledger
 * against the effective limits of ag1's own sub-account, with overage in
 * the plan's currency (the provider's when the client has none), valued
 * only while the client is rebilled (agency + client switch);
 * set_usage_limits is a card that writes the override only on confirm,
 * only in ag1.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/chat-route-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => ({
  ...(await import("@/test/chat-route-harness")).tenancyMock(),
  // The Manage dialog's usage route, read beside the tool.
  requireAgencyOwner: async () => ({ uid: "owner1", email: "o@example.com", agencyId: "ag1" }),
}));
vi.mock("@/lib/ai-suite/model", async () => (await import("@/test/chat-route-harness")).modelMock());
vi.mock("@/lib/ai-suite/usage", () => ({ recordAiSuiteUsage: async () => undefined }));
vi.mock("@/lib/ai-suite/audit", () => ({ recordAiSuiteAction: async () => undefined }));

const { availableOn, getCapability } = await import("@/lib/ai-suite/capabilities");

restoreBillingProviderAfterEach();

const month = usageMonthKey();

beforeEach(() => {
  seedTenants();
  spyBillingProvider("paystack");
  mem.seed("subAccounts/sb1", { agencyId: "ag2", name: "Other Agency Co", usageQuotas: { smsSegmentsPerMonth: 7 } });
  mem.seed(`subAccounts/sb1/usage/${month}`, { smsSegments: 424242 });
});
afterEach(() => vi.unstubAllEnvs());

/** Both usage-rebilling switches on for sa1. */
function rebill() {
  mem.seed("agencies/ag1", { ...mem.read("agencies/ag1")!, usageRebillingEnabled: true });
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, usageRebillingEnabled: true });
}

describe("sub_account_usage", () => {
  it("this month against the workspace override, CAPPED where hit, overage valued in the provider's currency", async () => {
    rebill();
    mem.seed("subAccounts/sa1", {
      ...mem.read("subAccounts/sa1")!,
      usageQuotas: { smsSegmentsPerMonth: 100, emailsPerMonth: 1000 },
      usageRates: { smsSegmentCents: 50 },
    });
    mem.seed(`subAccounts/sa1/usage/${month}`, { smsSegments: 120, emailsSent: 250, voiceSeconds: 600 });
    await askAgency("sub_account_usage", { subAccountId: "sa1", subAccountName: "W" });
    const out = lookupResult();
    expect(out).toContain(`Usage for “W” — ${month} (limits from: workspace override):`);
    expect(out).toContain("- SMS segments: 120 / 100 (120% — CAPPED)");
    expect(out).toContain("- Emails: 250 / 1,000 (25%)");
    expect(out).toContain("- Voice minutes: 10 / unlimited");
    // 20 segments over x 50c = R10.00, in ZAR: the client has no plan currency and Paystack is the provider.
    expect(out).toMatch(/Accrued overage this month: R\s10\.00/);
  });

  it.each(["paystack", "stripe"] as const)("on %s the tool and the Manage dialog's usage section show the same overage (breaker #413)", async (kind) => {
    spyBillingProvider(kind);
    rebill();
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, usageQuotas: { smsSegmentsPerMonth: 100 }, usageRates: { smsSegmentCents: 50 } });
    mem.seed(`subAccounts/sa1/usage/${month}`, { smsSegments: 120 });
    await askAgency("sub_account_usage", { subAccountId: "sa1" });
    const route = await import("@/app/api/agency/sub-accounts/[id]/usage/route");
    const page = (await (await route.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: "sa1" }) })).json()) as {
      currency: string; overage: { totalCents: number };
    };
    expect(page.currency).toBe(kind === "paystack" ? "zar" : "usd");
    // sub-account-usage-section.tsx renders formatBillingPrice(totalCents, currency).
    expect(lookupResult()).toContain(`Accrued overage this month: ${formatBillingPrice(page.overage.totalCents, page.currency)} `);
  });

  it("not rebilled: neither the tool nor the usage route values the overage", async () => {
    mem.seed("agencies/ag1", { ...mem.read("agencies/ag1")!, usageRebillingEnabled: true });
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, usageQuotas: { smsSegmentsPerMonth: 100 }, usageRates: { smsSegmentCents: 50 } });
    mem.seed(`subAccounts/sa1/usage/${month}`, { smsSegments: 120 });
    await askAgency("sub_account_usage", { subAccountId: "sa1" });
    expect(lookupResult()).toContain("Usage rebilling is off for this client, so overage isn't valued.");
    expect(lookupResult()).not.toContain("Accrued overage");
    const route = await import("@/app/api/agency/sub-accounts/[id]/usage/route");
    const page = (await (await route.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: "sa1" }) })).json()) as {
      overage: { totalCents: number };
    };
    expect(page.overage.totalCents).toBe(0);
  });

  it("limits from the assigned plan when there is no override", async () => {
    rebill();
    mem.seed("agencies/ag1/plans/plan_1", { name: "Growth", quotas: { whatsappPerMonth: 50 } });
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { planId: "plan_1", planName: "Growth", currency: "zar" } });
    await askAgency("sub_account_usage", { subAccountId: "sa1" });
    const out = lookupResult();
    expect(out).toContain("(limits from: plan “Growth”)");
    expect(out).toContain("- WhatsApp messages: 0 / 50 (0%)");
    expect(out).toContain("No overage accrued.");
  });

  it.each([["another agency's id", "sb1"], ["a path into another agency's ledger", `sb1/usage/${month}`]])(
    "%s reads nothing of it",
    async (_label, id) => {
      await askAgency("sub_account_usage", { subAccountId: id });
      const out = lookupResult();
      expect(out).toContain("wasn't found in this agency");
      expect(out).not.toContain("424,242");
    }
  );
});

describe("set_usage_limits", () => {
  it("is a card naming every unit that goes unlimited; the override is written only on confirm, only on sa1", async () => {
    const body = await (await askAgency("set_usage_limits", { subAccountId: "sa1", subAccountName: "W", smsSegmentsPerMonth: 500 })).json();
    expect(body).toMatchObject({ type: "proposal", proposal: { capability: "set_usage_limits" } });
    expect(body.proposal.summary).toBe("Set monthly limits on “W”: 500 SMS segments (every other unit unlimited, whatever the plan includes).");
    expect(mem.read("subAccounts/sa1")!.usageQuotas).toBeUndefined();

    const res = await confirmAgency("set_usage_limits", body.proposal.args);
    expect(res.status).toBe(200);
    expect(mem.read("subAccounts/sa1")!.usageQuotas).toEqual({ smsSegmentsPerMonth: 500 });
    expect(mem.read("subAccounts/sa2")!.usageQuotas).toBeUndefined();
  });

  it("a card naming another client is refused at confirm: nothing written", async () => {
    const before = JSON.stringify(mem.all());
    const res = await confirmAgency("set_usage_limits", { subAccountId: "sa1", subAccountName: "Other", emailsPerMonth: 1 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("it is “W”");
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it("no name on the card is not a card", () => {
    expect(getCapability("set_usage_limits")!.validate({ subAccountId: "sa1", emailsPerMonth: 5 })).toMatchObject({ ok: false });
  });

  it("the reply shows this month's usage against each new limit, flagging one already reached", async () => {
    mem.seed(`subAccounts/sa1/usage/${month}`, { smsSegments: 120, voiceSeconds: 600 });
    const res = await confirmAgency("set_usage_limits", { subAccountId: "sa1", subAccountName: "W", smsSegmentsPerMonth: 100, voiceMinutesPerMonth: 30 });
    const text = (await res.json()).resultText as string;
    expect(text).toContain("- SMS segments: 120 used of 100 — already reached: paused now until the month resets");
    expect(text).toContain("- voice minutes: 10 used of 30\n");
  });

  it("clear=true removes the override", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, usageQuotas: { emailsPerMonth: 5 } });
    const res = await confirmAgency("set_usage_limits", { subAccountId: "sa1", subAccountName: "W", clear: true });
    expect((await res.json()).resultText).toContain("Removed the usage-limit override on “W”");
    expect(mem.read("subAccounts/sa1")!.usageQuotas).toBeNull();
  });

  it.each([
    [{ subAccountId: "sa1", subAccountName: "W" }],
    [{ subAccountId: "sa1", subAccountName: "W", clear: true, emailsPerMonth: 5 }],
    [{ subAccountId: "sa1", subAccountName: "W", emailsPerMonth: 0 }],
    [{ subAccountId: "sa1", subAccountName: "W", emailsPerMonth: 2.5 }],
    [{ subAccountId: "sa1", subAccountName: "W", emailsPerMonth: "5" }],
    [{ subAccountId: " sa1", subAccountName: "W", emailsPerMonth: 5 }],
    [{ subAccountId: "sa1", emailsPerMonth: 5 }],
    [{ subAccountId: "sa1", subAccountName: "W", emailsPerMonth: -1 }],
    [{ subAccountId: "sa1", subAccountName: "W", emailsPerMonth: NaN }],
    [{ subAccountId: "sa1", subAccountName: "W", emailsPerMonth: 1e300 }],
    [{ subAccountId: "sa1", subAccountName: "W", emailsPerMonth: Infinity }],
    [{ subAccountId: "sa1", subAccountName: "W", clear: "true" }],
  ])("%j is not a valid call: confirm refuses, nothing written", async (args) => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, usageQuotas: { emailsPerMonth: 5 } });
    const before = JSON.stringify(mem.all());
    expect((await confirmAgency("set_usage_limits", args)).status).toBe(400);
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it.each([[{ emailsPerMonth: 0.5 }], [{ emailsPerMonth: -3 }], [{ emailsPerMonth: "9" }]])(
    "a hand-posted confirm carrying validated-looking limits %j writes nothing (breaker #413)",
    async (limits) => {
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, usageQuotas: { emailsPerMonth: 5 } });
      await confirmAgency("set_usage_limits", { subAccountId: "sa1", subAccountName: "W", clear: false, limits });
      expect(mem.read("subAccounts/sa1")!.usageQuotas).toEqual({ emailsPerMonth: 5 });
    }
  );

  it("execute never reads a set without a valid limit as clear", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, usageQuotas: { emailsPerMonth: 5 } });
    const owner = { uid: "owner1", email: "o@example.com", displayName: "", agencyId: "ag1" };
    await expect(getCapability("set_usage_limits")!.execute(owner, { subAccountId: "sa1", subAccountName: "W", clear: false, limits: {} })).rejects.toThrow("give at least one limit");
    expect(mem.read("subAccounts/sa1")!.usageQuotas).toEqual({ emailsPerMonth: 5 });
  });

  it.each([["another agency's id", "sb1"], ["a path, not an id", `sa1/usage/${month}`]])(
    "%s is refused at confirm: nothing written",
    async (_label, id) => {
      mem.seed(`subAccounts/sa1/usage/${month}`, { agencyId: "ag1", smsSegments: 1 });
      const before = JSON.stringify(mem.all());
      const res = await confirmAgency("set_usage_limits", { subAccountId: id, subAccountName: "X", emailsPerMonth: 1 });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("That sub-account wasn't found in this agency.");
      expect(JSON.stringify(mem.all())).toBe(before);
    }
  );

  it("is chat-only", () => {
    expect(availableOn(getCapability("set_usage_limits")!, "agent")).toBe(false);
  });
});
