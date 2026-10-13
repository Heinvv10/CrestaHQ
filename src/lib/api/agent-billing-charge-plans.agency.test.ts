import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { agencyKey, decideAgency, seedAgency, underNullSubAccount } from "@/test/agency-approvals-harness";
import { restoreBillingProviderAfterEach, spyBillingProvider } from "@/test/billing-provider-spies";

/**
 * The other three billing tools on an agency key (AGENCY_AGENT_API_PLAN.md
 * A4b). `create_one_time_charge` is always an agency-level `spend` row,
 * approved once with the pinned charge; `create_billing_plan` writes at once
 * (it bills nobody) and is audited under the agency; `list_billing_plans`
 * reads only the caller's agency. With no payment provider configured, every
 * write is a clean refusal: no row, no doc, no 500. Real dispatch, decide
 * route, capabilities, service and provider selection; provider methods spied.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agency-approvals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const { dispatchAgentTool } = await import("./agent-dispatch");

await setupAgentProposalTests();
restoreBillingProviderAfterEach();

const CHARGE = { subAccountId: "sa1", subAccountName: "Client One", description: "Web design", amount: 500, currency: "zar" };
const PLAN = { name: "Growth", priceMonthly: 99, currency: "zar", features: ["broadcasts"] };

beforeEach(() => {
  seedAgency();
  vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "test-secret-for-checkout-tokens-0123456789");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example");
});
afterEach(() => vi.unstubAllEnvs());

describe("create_one_time_charge", () => {
  it("propose → one spend row with the charge pinned; no charge doc, no provider call", async () => {
    const spies = spyBillingProvider("stripe");
    const r = await dispatchAgentTool(agencyKey, "create_one_time_charge", CHARGE);
    expect(r).toMatchObject({ ok: true, proposal: { status: "pending" } });
    const id = (r as { proposal: { id: string } }).proposal.id;
    expect(row(id)).toMatchObject({
      subAccountId: null, targetSubAccountId: "sa1", approval: "spend",
      pinned: { subAccountId: "sa1", description: "Web design", amountCents: 50000, currency: "zar" },
    });
    expect(row(id).preview).toEqual([
      { label: "Sub-account", value: "Client One" },
      { label: "Charge", value: "“Web design”" },
      { label: "Amount", value: "ZAR 500" },
      { label: "Payment", value: "One payment link for you to send the client; nothing is charged until they pay. Not a subscription." },
    ]);
    expect(mem.list("billingCharges")).toEqual([]);
    expect(spies.calls()).toBe(0);
  });

  it("approve → the charge created once with the pinned values, by the approving owner, with its link", async () => {
    const spies = spyBillingProvider("paystack");
    const r = await dispatchAgentTool(agencyKey, "create_one_time_charge", CHARGE);
    const res = await decideAgency((r as { proposal: { id: string } }).proposal.id, "approve");
    expect(res.status).toBe(200);
    expect((await res.json()).resultText).toMatch(/Payment link to send the client:\nhttps:\/\/crm\.example\/pay\/charge\//);
    expect(mem.list("billingCharges")).toEqual([
      expect.objectContaining({ subAccountId: "sa1", agencyId: "ag1", description: "Web design", amountCents: 50000, currency: "zar", createdByUid: "owner1", status: "pending" }),
    ]);
    expect(spies.calls()).toBe(0);
    expect(mem.list("aiSuiteActions")).toEqual([expect.objectContaining({ subAccountId: "sa1", capability: "create_one_time_charge" })]);
    expect(underNullSubAccount()).toEqual([]);
  });

  it("execute on the agent surface without an approval refuses: no charge", async () => {
    spyBillingProvider("stripe");
    const { getCapability } = await import("@/lib/ai-suite/capabilities");
    const { buildAgencyAgentContext } = await import("./agent-context");
    const cap = getCapability("create_one_time_charge")!;
    const v = cap.validate(CHARGE);
    if (!v.ok) throw new Error(v.error);
    await expect(cap.execute(buildAgencyAgentContext(agencyKey), v.args)).rejects.toThrow(/needs the agency owner's approval/);
    expect(mem.list("billingCharges")).toEqual([]);
  });

  it("no provider configured → a clean refusal at propose: 400, no row, no charge", async () => {
    spyBillingProvider("none");
    expect(await dispatchAgentTool(agencyKey, "create_one_time_charge", CHARGE)).toEqual({
      ok: false, code: "invalid_request", httpStatus: 400,
      message: "No payment provider is configured on this deployment, so no charge can be created.",
    });
    expect(mem.list("agentProposals")).toEqual([]);
    expect(mem.list("billingCharges")).toEqual([]);
  });

  it("a currency Paystack can't settle is refused at validate; Stripe takes it", async () => {
    spyBillingProvider("paystack");
    expect(await dispatchAgentTool(agencyKey, "create_one_time_charge", { ...CHARGE, currency: "eur" })).toMatchObject({
      ok: false, code: "invalid_args", message: expect.stringMatching(/Paystack can't settle EUR/),
    });
    spyBillingProvider("stripe");
    expect(await dispatchAgentTool(agencyKey, "create_one_time_charge", { ...CHARGE, currency: "eur" })).toMatchObject({ ok: true });
  });
});

describe("create_one_time_charge with no currency named: the client's overage currency (PR #413 round 3)", () => {
  const { currency: _c, ...UNNAMED } = CHARGE;
  const owner = { uid: "owner1", email: "o@x.io", displayName: "", agencyId: "ag1" };
  const usdPlan = () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { status: "active", planId: "p1", currency: "usd" } });
  const chat = async (args: Record<string, unknown>) => {
    const { getCapability } = await import("@/lib/ai-suite/capabilities");
    const cap = getCapability("create_one_time_charge")!;
    const v = cap.validate(args);
    if (!v.ok) throw new Error(v.error);
    return cap.execute(owner, v.args);
  };

  it("no plan on Paystack: charged in ZAR, the overage currency, from chat and on an approved agent row", async () => {
    spyBillingProvider("paystack");
    await chat(UNNAMED);
    const r = await dispatchAgentTool(agencyKey, "create_one_time_charge", { ...UNNAMED, description: "Overage" });
    expect(row((r as { proposal: { id: string } }).proposal.id).pinned).toMatchObject({ currency: "zar" });
    expect(mem.list("billingCharges")).toEqual([expect.objectContaining({ currency: "zar" })]);
  });

  it("a client billed in USD on Paystack: the card said ZAR, so chat refuses rather than bill in another currency; the agent's propose is refused", async () => {
    spyBillingProvider("paystack");
    usdPlan();
    await expect(chat(UNNAMED)).rejects.toThrow("This client is billed in USD, not ZAR: ask again naming the currency to charge in.");
    expect(await dispatchAgentTool(agencyKey, "create_one_time_charge", UNNAMED)).toMatchObject({ ok: false, httpStatus: 400, message: expect.stringContaining("billed in USD") });
    expect(mem.list("billingCharges")).toEqual([]);
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("naming the currency charges in it, whatever the client is billed in", async () => {
    spyBillingProvider("paystack");
    usdPlan();
    await chat({ ...UNNAMED, currency: "zar" });
    expect(mem.list("billingCharges")).toEqual([expect.objectContaining({ currency: "zar" })]);
  });

  it("a stored proposal re-validates to the same args (the omission survives)", async () => {
    const { getCapability } = await import("@/lib/ai-suite/capabilities");
    const cap = getCapability("create_one_time_charge")!;
    const once = cap.validate(UNNAMED);
    if (!once.ok) throw new Error(once.error);
    expect(cap.validate(once.args)).toEqual(once);
  });
});

describe("create_billing_plan: direct, it bills nobody", () => {
  it("writes the plan in the caller's agency, once through the provider, audited under the agency", async () => {
    const spies = spyBillingProvider("stripe");
    const r = await dispatchAgentTool(agencyKey, "create_billing_plan", PLAN);
    expect(r).toMatchObject({ ok: true, ref: { kind: "billingPlan" } });
    const planId = (r as { ref: { id: string } }).ref.id;
    expect(mem.read(`agencies/ag1/plans/${planId}`)).toMatchObject({ name: "Growth", priceMonthlyCents: 9900, gates: expect.objectContaining({ broadcastsEnabledByAgency: true }) });
    expect(spies.createPlan).toHaveBeenCalledTimes(1);
    expect(mem.list("agentProposals")).toEqual([]);
    expect(mem.list("auditEvents").filter((e) => e.action === "agent.write")).toEqual([
      expect.objectContaining({
        agencyId: "ag1", subAccountId: null, actor: { type: "api_key", id: "ak1" }, target: { type: "billingPlan", id: planId },
        changes: expect.arrayContaining([{ field: "capability", before: null, after: "create_billing_plan" }]),
      }),
    ]);
    expect(underNullSubAccount()).toEqual([]);
  });

  it("an assistant-locked feature is refused through the agent path too", async () => {
    spyBillingProvider("stripe");
    expect(await dispatchAgentTool(agencyKey, "create_billing_plan", { ...PLAN, features: ["api-access"] })).toMatchObject({
      ok: false, httpStatus: 400, message: expect.stringMatching(/only be added to a plan by the agency owner/),
    });
  });

  it("no provider configured → a clean refusal: 400 'isn't configured', no plan, no audit row", async () => {
    const spies = spyBillingProvider("none");
    expect(await dispatchAgentTool(agencyKey, "create_billing_plan", PLAN)).toMatchObject({
      ok: false, code: "invalid_request", httpStatus: 400, message: expect.stringMatching(/isn't configured/),
    });
    expect(mem.list("agencies/ag1/plans")).toEqual([]);
    expect(mem.list("auditEvents")).toEqual([]);
    expect(spies.calls()).toBe(0);
  });
});

describe("list_billing_plans reads only the caller's agency", () => {
  it("another agency's plan never appears; works with no provider", async () => {
    spyBillingProvider("none");
    const plan = { name: "Ours", status: "active", currency: "zar", priceMonthlyCents: 9900, gates: {} };
    mem.seed("agencies/ag1/plans/p1", plan);
    mem.seed("agencies/ag2/plans/p2", { ...plan, name: "Theirs" });
    const r = await dispatchAgentTool(agencyKey, "list_billing_plans", {});
    expect(r).toMatchObject({ ok: true });
    const text = (r as { resultText: string }).resultText;
    expect(text).toContain("Ours (id: p1)");
    expect(text).not.toContain("Theirs");
  });
});
