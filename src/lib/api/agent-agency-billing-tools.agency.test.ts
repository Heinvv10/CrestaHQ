import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { agencyKey, decideAgency, seedAgency, underNullSubAccount } from "@/test/agency-approvals-harness";
import { restoreBillingProviderAfterEach, spyBillingProvider } from "@/test/billing-provider-spies";
import { PENDING_BILLING } from "@/test/preview-samples";
import { usageMonthKey } from "@/lib/server/usage-meter";

/**
 * N2b's agency tools on an agency key (UPSTREAM_PORT_PLAN.md): the reads
 * see only sub-accounts the key reaches; resend_checkout_link is always an
 * agency-level outbound row that pins the plan the link pays and mints
 * nothing until the owner approves it, once; comp_client, set_usage_limits
 * and deployment_setup_status are not on the agent surface at all. Real
 * dispatch, decide route, capabilities and billing service; provider spied.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agency-approvals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const { dispatchAgentTool } = await import("./agent-dispatch");

setupAgentProposalTests();
restoreBillingProviderAfterEach();

const month = usageMonthKey();
const hash = () => (mem.read("subAccounts/sa1")!.billing as { checkoutTokenHash: unknown }).checkoutTokenHash;
const proposalId = (r: unknown) => (r as { proposal: { id: string } }).proposal.id;

beforeEach(() => {
  seedAgency();
  spyBillingProvider("paystack");
  vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "test-secret-for-checkout-tokens-0123456789");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example");
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: PENDING_BILLING });
  // In this agency, but the key does not reach it (its Agent API gate is off).
  mem.seed("subAccounts/sa9", { agencyId: "ag1", name: "Unreached Co", apiAccessEnabledByAgency: true, billing: { ...PENDING_BILLING, priceCents: 424200 } });
  mem.seed(`subAccounts/sa9/usage/${month}`, { smsSegments: 424242 });
});
afterEach(() => vi.unstubAllEnvs());

describe("the reads see only what the key reaches", () => {
  it("billing_overview lists reachable sub-accounts only", async () => {
    const r = await dispatchAgentTool(agencyKey, "billing_overview", {});
    expect(r).toMatchObject({ ok: true });
    const text = (r as { resultText: string }).resultText;
    expect(text).toContain("Client One");
    expect(text).toContain("Client billing of the sub-accounts this key reaches (");
    expect(text).toContain("MRR of the sub-accounts this key reaches");
    expect(text).not.toContain("Unreached Co");
    expect(text).not.toContain("Other Co");
    expect(text).not.toContain("4,242");
  });

  it("sub_account_usage on a sub-account the key doesn't reach is the one not-found", async () => {
    expect(await dispatchAgentTool(agencyKey, "sub_account_usage", { subAccountId: "sa9" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await dispatchAgentTool(agencyKey, "sub_account_usage", { subAccountId: "sa1" })).toMatchObject({ ok: true });
  });
});

describe("resend_checkout_link", () => {
  it("propose → one agency-level outbound row pinning the plan; no link minted, no provider call", async () => {
    const spies = spyBillingProvider("paystack");
    const r = await dispatchAgentTool(agencyKey, "resend_checkout_link", { subAccountId: "sa1", subAccountName: "Agent's word" });
    expect(r).toMatchObject({ ok: true, proposal: { status: "pending" } });
    const id = proposalId(r);
    expect(row(id)).toMatchObject({
      subAccountId: null, targetSubAccountId: "sa1", approval: "outbound",
      args: { subAccountId: "sa1" },
      pinned: {
        subAccountId: "sa1", planId: "plan_sample", priceCents: 9900, billingInterval: "month", currency: "zar",
        stripePriceId: "price_m", status: "pending",
      },
    });
    const preview = row(id).preview as Array<{ label: string; value: string }>;
    expect(preview.map((p) => p.label)).toEqual(["Sub-account", "Plan", "Billing status", "Link"]);
    expect(preview[0]!.value).toBe("Client One");
    expect(hash()).toBe("old_hash");
    expect(spies.calls()).toBe(0);
  });

  it("approve → the link minted once by the owner: the old one dies and the URL is returned", async () => {
    const id = proposalId(await dispatchAgentTool(agencyKey, "resend_checkout_link", { subAccountId: "sa1" }));
    const res = await decideAgency(id, "approve");
    expect(res.status).toBe(200);
    expect((await res.json()).resultText).toMatch(/^New checkout link for “Client One”: https:\/\/crm\.example\/pay\//);
    expect(hash()).not.toBe("old_hash");
    expect(hash()).toEqual(expect.any(String));
    expect(underNullSubAccount()).toEqual([]);
  });

  it("the plan changed after proposing: approve shows the new preview instead of minting", async () => {
    const id = proposalId(await dispatchAgentTool(agencyKey, "resend_checkout_link", { subAccountId: "sa1" }));
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...PENDING_BILLING, priceCents: 19900 } });
    const res = await decideAgency(id, "approve");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("preview_changed");
    expect(hash()).toBe("old_hash");
  });

  it("execute with pins that no longer match refuses: no link", async () => {
    const { getCapability } = await import("@/lib/ai-suite/capabilities");
    const owner = { uid: "owner1", email: "o@x.io", displayName: "", agencyId: "ag1" };
    const approved = { pinned: { subAccountId: "sa1", planId: "plan_sample", priceCents: 4900, status: "pending" } };
    await expect(getCapability("resend_checkout_link")!.execute({ ...owner, approved }, { subAccountId: "sa1" })).rejects.toThrow("changed since this was reviewed");
    expect(hash()).toBe("old_hash");
  });

  it.each([
    ["the cadence and provider price (monthly R99 → annual R99)", { billingInterval: "year", stripePriceId: "price_y" }],
    ["the currency at the same cents (zar → usd)", { currency: "usd" }],
  ])("approved, then %s changed before execute: refused, no link (breaker #413)", async (_label, change) => {
    const id = proposalId(await dispatchAgentTool(agencyKey, "resend_checkout_link", { subAccountId: "sa1" }));
    const { getCapability } = await import("@/lib/ai-suite/capabilities");
    const owner = { uid: "owner1", email: "o@x.io", displayName: "", agencyId: "ag1" };
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...PENDING_BILLING, ...change } });
    const approved = { pinned: row(id).pinned as Record<string, unknown> };
    await expect(getCapability("resend_checkout_link")!.execute({ ...owner, approved }, { subAccountId: "sa1" })).rejects.toThrow("changed since");
    expect(hash()).toBe("old_hash");
  });

  it("no app URL: an approved call refuses before rotating, so the old link keeps working", async () => {
    const id = proposalId(await dispatchAgentTool(agencyKey, "resend_checkout_link", { subAccountId: "sa1" }));
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const res = await decideAgency(id, "approve");
    expect((await res.json()).error).toMatch(/NEXT_PUBLIC_APP_URL isn't configured/);
    expect(hash()).toBe("old_hash");
  });

  it.each([
    ["an active subscription", { ...PENDING_BILLING, status: "active" }, "already has an active subscription"],
    ["a comped client", { status: "comped", planId: null }, "no plan assigned"],
  ])("%s: refused at propose, no row", async (_label, billing, message) => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing });
    expect(await dispatchAgentTool(agencyKey, "resend_checkout_link", { subAccountId: "sa1" })).toMatchObject({
      ok: false, httpStatus: 400, message: expect.stringContaining(message),
    });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("no payment provider: refused at propose, no row", async () => {
    spyBillingProvider("none");
    expect(await dispatchAgentTool(agencyKey, "resend_checkout_link", { subAccountId: "sa1" })).toMatchObject({ ok: false, httpStatus: 400 });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("another agency's sub-account, or one the key doesn't reach: not found, no row", async () => {
    for (const id of ["sb1", "sa9"]) {
      expect(await dispatchAgentTool(agencyKey, "resend_checkout_link", { subAccountId: id })).toMatchObject({ ok: false, code: "not_found" });
    }
    expect(mem.list("agentProposals")).toEqual([]);
  });
});

describe("the chat-only tools are not on the agent surface", () => {
  it.each([
    ["comp_client", { subAccountId: "sa1", subAccountName: "Client One" }],
    ["set_usage_limits", { subAccountId: "sa1", subAccountName: "Client One", emailsPerMonth: 1 }],
    ["deployment_setup_status", {}],
  ])("%s: not available, nothing written", async (name, args) => {
    const before = JSON.stringify(mem.all());
    expect(await dispatchAgentTool(agencyKey, name, args)).toMatchObject({ ok: false, code: "not_available" });
    expect(JSON.stringify(mem.all())).toBe(before);
  });
});
