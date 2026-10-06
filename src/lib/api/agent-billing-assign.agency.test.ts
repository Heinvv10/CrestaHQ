import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { agencyKey, decideAgency, listAgency, seedAgency, underNullSubAccount } from "@/test/agency-approvals-harness";
import { restoreBillingProviderAfterEach, spyBillingProvider, type ProviderKind } from "@/test/billing-provider-spies";
import { batchEligible, type AgencyApprovalRow } from "@/lib/approvals/agency-batch";

/**
 * `assign_billing_plan` on an agency key (AGENCY_AGENT_API_PLAN.md A4b): always
 * an agency-level `spend` row — no provider call, nothing written — whose
 * preview names the plan, the price, every gate going on and off (the two
 * that change reach flagged) and what happens to billing, by provider.
 * Approved on /agency/approvals it assigns once with the pinned price and
 * gates, refusing a plan edited before the claim (preview_changed) or after
 * it (pinned_mismatch, inside assignPlanToSubAccount's own plan read). Real
 * dispatch, decide route, capability, service and provider selection; every
 * provider method is a spy.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agency-approvals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const { dispatchAgentTool } = await import("./agent-dispatch");
const { normalizePlanGates } = await import("@/lib/server/billing-lifecycle");

setupAgentProposalTests();
restoreBillingProviderAfterEach();

const PLAN = {
  name: "Growth", status: "active", currency: "zar", priceMonthlyCents: 9900, priceAnnualCents: null,
  stripeProductId: "prod_1", stripePriceId: "price_m", stripeAnnualPriceId: null,
  gates: { broadcastsEnabledByAgency: true, apiAccessEnabledByAgency: false, labsEnabledByAgency: false },
};
const LIVE = { status: "active", planId: "plan_old", stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" };
const ARGS = { subAccountId: "sa1", subAccountName: "Client One", planId: "plan_1", planName: "Growth" };

beforeEach(() => {
  seedAgency();
  vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "test-secret-for-checkout-tokens-0123456789");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example");
  mem.seed("agencies/ag1/plans/plan_1", PLAN);
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), labsEnabledByAgency: true, billing: LIVE });
});

afterEach(() => vi.unstubAllEnvs());

async function propose(args: Record<string, unknown> = ARGS) {
  const r = await dispatchAgentTool(agencyKey, "assign_billing_plan", args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const rowValue = (id: string, label: string) =>
  (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;

describe("propose: an agency-level spend row, nothing charged", () => {
  it("Stripe, live subscription: the full preview, pins, and no provider call", async () => {
    const spies = spyBillingProvider("stripe");
    const id = await propose();
    expect(row(id)).toMatchObject({
      subAccountId: null, targetSubAccountId: "sa1", approval: "spend", keyLevel: "agency", status: "pending",
      summary: "Assign plan “plan_1” (monthly) to “sa1”.",
      pinned: {
        planId: "plan_1", planName: "Growth", priceCents: 9900, interval: "month", specialPriceCents: null, currency: "zar",
        // Exactly the gates the plan names: an unnamed gate is left alone, a named-false one switched off.
        gates: { broadcastsEnabledByAgency: true, apiAccessEnabledByAgency: false, labsEnabledByAgency: false },
      },
    });
    expect(row(id).preview).toEqual([
      { label: "Sub-account", value: "Client One" },
      { label: "Plan", value: "“Growth”" },
      { label: "Price", value: "ZAR 99 per month" },
      { label: "Switches on", value: "Email broadcasts" },
      { label: "Switches off", value: "Public API access (changes reach: API and agent keys lose this sub-account), Labs (pre-release features)" },
      { label: "Included each month", value: "Unlimited" },
      { label: "Overage rates", value: "None" },
      { label: "Features change", value: "Now" },
      { label: "Billing", value: "Switches the live subscription now, prorated." },
    ]);
    expect(spies.calls()).toBe(0);
    expect(mem.read("subAccounts/sa1")).toMatchObject({ billing: LIVE, broadcastsEnabledByAgency: false, labsEnabledByAgency: true });
  });

  it.each([
    ["paystack", LIVE, "Features switch now; the new price starts at the next renewal.", "Now"],
    ["stripe", null, "The client gets a checkout link; the workspace is behind an activation screen until they pay.", "When the client pays"],
    ["none", LIVE, "No payment provider is configured on this deployment: approving fails and changes nothing.", "Now"],
  ] as const)("%s, billing %j → the provider's own line", async (kind, billing, line, when) => {
    const spies = spyBillingProvider(kind as ProviderKind);
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), billing });
    const id = await propose();
    expect([rowValue(id, "Billing"), rowValue(id, "Features change")]).toEqual([line, when]);
    expect(spies.calls()).toBe(0);
  });

  it("a gate on by default (never stored) is listed switching off; the sending domain is flagged as reach", async () => {
    spyBillingProvider("stripe");
    mem.seed("agencies/ag1/plans/plan_1", { ...PLAN, gates: { smsAgentEnabledByAgency: false, emailDomainEnabledByAgency: true } });
    const id = await propose();
    expect(rowValue(id, "Switches off")).toBe("SMS AI auto-reply");
    expect(rowValue(id, "Switches on")).toBe("Dedicated email sending domain (changes reach: its own sending domain)");
  });

  it("the plan's usage quotas and overage rates are shown; editing one before approve is preview_changed", async () => {
    const spies = spyBillingProvider("stripe");
    mem.seed("agencies/ag1/plans/plan_1", {
      ...PLAN, quotas: { emailsPerMonth: 5000, smsSegmentsPerMonth: 0, whatsappPerMonth: null }, rates: { emailCents: 2, voiceMinuteCents: 150 },
    });
    const id = await propose();
    expect([rowValue(id, "Included each month"), rowValue(id, "Overage rates")]).toEqual([
      "5,000 emails, 0 SMS segments",
      "ZAR 0.02 per email, ZAR 1.5 per voice minute",
    ]);
    mem.seed("agencies/ag1/plans/plan_1", { ...mem.read("agencies/ag1/plans/plan_1"), rates: { emailCents: 3, voiceMinuteCents: 150 } });
    const res = await decideAgency(id, "approve");
    expect([res.status, (await res.json()).error]).toEqual([409, "preview_changed"]);
    expect(spies.calls()).toBe(0);
  });

  it("a special price is shown beside the plan's and pinned", async () => {
    spyBillingProvider("stripe");
    const id = await propose({ ...ARGS, specialPrice: 50 });
    expect(rowValue(id, "Price")).toBe("ZAR 50 per month (special price; the plan's is ZAR 99)");
    expect(row(id).pinned).toMatchObject({ priceCents: 9900, specialPriceCents: 5000 });
  });

  it("the agent's own labels never reach the row: the summary names ids, the preview the stored names", async () => {
    spyBillingProvider("stripe");
    const id = await propose({ ...ARGS, planName: "Free trial", subAccountName: "Someone else" });
    expect(row(id).args).toEqual({ subAccountId: "sa1", subAccountName: "", planId: "plan_1", planName: "", interval: "month", specialPriceCents: null });
    expect(JSON.stringify(row(id))).not.toMatch(/Free trial|Someone else/);
  });

  it("an unknown plan and another agency's plan get the identical 404, no row", async () => {
    spyBillingProvider("stripe");
    mem.seed("agencies/ag2/plans/plan_2", PLAN);
    const other = await dispatchAgentTool(agencyKey, "assign_billing_plan", { ...ARGS, planId: "plan_2" });
    const madeUp = await dispatchAgentTool(agencyKey, "assign_billing_plan", { ...ARGS, planId: "nope" });
    expect(other).toMatchObject({ ok: false, code: "not_found", httpStatus: 404 });
    expect(JSON.stringify(other)).toBe(JSON.stringify(madeUp));
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("a plan that would switch on an assistant-locked gate is refused at propose (checkout path judged as all off)", async () => {
    const spies = spyBillingProvider("stripe");
    mem.seed("agencies/ag1/plans/plan_1", { ...PLAN, gates: { ...PLAN.gates, apiAccessEnabledByAgency: true } });
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), billing: null });
    expect(await dispatchAgentTool(agencyKey, "assign_billing_plan", ARGS)).toMatchObject({
      ok: false, httpStatus: 400, message: expect.stringMatching(/would switch on Public API access/),
    });
    expect(mem.list("agentProposals")).toEqual([]);
    expect(spies.calls()).toBe(0);
  });

  it("execute on the agent surface without an approval refuses: no provider call", async () => {
    const spies = spyBillingProvider("stripe");
    const { getCapability } = await import("@/lib/ai-suite/capabilities");
    const { buildAgencyAgentContext } = await import("./agent-context");
    await expect(
      getCapability("assign_billing_plan")!.execute(buildAgencyAgentContext(agencyKey), { ...ARGS, interval: "month", specialPriceCents: null })
    ).rejects.toThrow(/needs the agency owner's approval/);
    expect(spies.calls()).toBe(0);
  });

  it("never batch-eligible, even on a key-created target", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/kc", {
      agencyId: "ag1", name: "Key Co", agentApiEnabledByAgency: true, apiAccessEnabledByAgency: true, createdByKeyId: "ak1", createdAt: new Date(),
    });
    const id = await propose({ ...ARGS, subAccountId: "kc" });
    const { proposals } = (await (await listAgency()).json()) as { proposals: AgencyApprovalRow[] };
    const listed = proposals.find((p) => p.id === id)!;
    expect(listed).toMatchObject({ approval: "spend", keyCreated: true });
    expect(batchEligible(listed)).toBe(false);
  });
});

describe.each(["stripe", "paystack"] as const)("approve on %s", (kind) => {
  it("switches once at the plan's price: no special price stamped, gates applied, audited under the target", async () => {
    const spies = spyBillingProvider(kind);
    const id = await propose();
    const res = await decideAgency(id, "approve");
    expect(res.status).toBe(200);
    expect((await res.json()).resultText).toMatch(kind === "stripe" ? /re-priced \(prorated\)/ : /new price starts at the next renewal/);
    expect(spies.switchSubscriptionPlan).toHaveBeenCalledTimes(1);
    expect(spies.createPrice).not.toHaveBeenCalled();
    expect(mem.read("subAccounts/sa1")).toMatchObject({
      billing: { planId: "plan_1", priceCents: 9900, specialPriceCents: null },
      broadcastsEnabledByAgency: true, apiAccessEnabledByAgency: false, labsEnabledByAgency: false,
    });
    expect(mem.list("aiSuiteActions")).toEqual([expect.objectContaining({ subAccountId: "sa1", capability: "assign_billing_plan", status: "executed" })]);
    expect(underNullSubAccount()).toEqual([]);
  });

  it("a proposed special price is minted and stamped", async () => {
    const spies = spyBillingProvider(kind);
    const id = await propose({ ...ARGS, specialPrice: 50 });
    expect((await decideAgency(id, "approve")).status).toBe(200);
    expect(spies.createPrice).toHaveBeenCalledWith(expect.objectContaining({ unitAmountCents: 5000 }));
    expect(mem.read("subAccounts/sa1")?.billing).toMatchObject({ priceCents: 5000, specialPriceCents: 5000 });
  });

  it("the plan's price edited between propose and approve → 409 preview_changed, no provider call", async () => {
    const spies = spyBillingProvider(kind);
    const id = await propose();
    mem.seed("agencies/ag1/plans/plan_1", { ...PLAN, priceMonthlyCents: 12900 });
    const res = await decideAgency(id, "approve");
    expect([res.status, (await res.json()).error]).toEqual([409, "preview_changed"]);
    expect(spies.calls()).toBe(0);
    expect(row(id).status).toBe("pending");
  });

  it.each([
    ["a gate switched on", () => ({ ...PLAN.gates, labsEnabledByAgency: true })],
    // The plan editor writes every gate: the ones this plan never named become false and would switch off.
    ["re-saved in the plan editor (every gate named)", () => normalizePlanGates(PLAN.gates)],
  ])("the plan edited after the claim (%s) → execute refuses pinned_mismatch, no provider call, nothing written", async (_label, gates) => {
    const spies = spyBillingProvider(kind);
    const id = await propose();
    expect((row(id).pinned as { gates: unknown }).gates).toEqual(PLAN.gates);
    const original = mem.db.runTransaction.bind(mem.db);
    vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn) => {
      const out = await original(fn as Parameters<typeof original>[0]);
      mem.seed("agencies/ag1/plans/plan_1", { ...PLAN, gates: gates() });
      return out;
    });
    const res = await decideAgency(id, "approve");
    expect(res.status).toBe(422);
    expect(spies.calls()).toBe(0);
    expect(row(id)).toMatchObject({ status: "failed", error: expect.stringMatching(/^pinned_mismatch/) });
    expect(mem.read("subAccounts/sa1")).toMatchObject({ billing: LIVE, broadcastsEnabledByAgency: false });
  });
});

describe("approve without a live subscription, or without a provider", () => {
  it("Stripe, no live subscription → pending with a checkout link, no provider call", async () => {
    const spies = spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), billing: null });
    const id = await propose();
    const res = await decideAgency(id, "approve");
    expect((await res.json()).resultText).toMatch(/Checkout link to send the client:\n\S+/);
    expect(mem.read("subAccounts/sa1")?.billing).toMatchObject({ status: "pending", planId: "plan_1", specialPriceCents: null });
    expect(spies.calls()).toBe(0);
  });

  it("no provider configured → the row fails cleanly: 422, not configured, nothing written, no 500", async () => {
    const spies = spyBillingProvider("none");
    const id = await propose();
    const res = await decideAgency(id, "approve");
    expect(res.status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: expect.stringMatching(/isn't configured/) });
    expect(spies.calls()).toBe(0);
    expect(mem.read("subAccounts/sa1")).toMatchObject({ billing: LIVE, broadcastsEnabledByAgency: false });
    expect(underNullSubAccount()).toEqual([]);
  });
});
