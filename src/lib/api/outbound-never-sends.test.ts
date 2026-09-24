import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * The inverted outbound test (AGENT_API_V1_PLAN.md, PR3b): an API agent can
 * never make the CRM contact a person on its own. EVERY agent-surfaced
 * non-approval capability is dispatched — with ACTIVE workflows matching
 * every trigger they fire — while every outbound seam is spied: Twilio,
 * SMTP, Resend, Meta, WhatsApp Cloud, global fetch, QStash publish, the
 * review-request sender, and the workflow run writer (no workflowRuns doc).
 * Every one must stay at 0 calls. The real fireWorkflowTrigger is wrapped so
 * every trigger a row fires — awaited or leaked fire-and-forget — is awaited
 * (plus a macrotask flush) before that row asserts, so a leak is caught by
 * its own row even when it runs alone.
 *
 * Arg fixtures come from a table keyed by capability name: a new
 * agent-surfaced capability without an entry fails the first test.
 */

const spies = vi.hoisted(() => {
  const fn = () => vi.fn(async () => { throw new Error("outbound seam called"); });
  return {
    sendSmsForSubAccount: fn(), sendWhatsappForSubAccount: fn(), sendWhatsappTemplateForSubAccount: fn(), sendSms: fn(),
    sendSmtpEmail: fn(), sendEmail: fn(), sendPlainTextBroadcast: fn(),
    sendMetaMessage: fn(), publishToFacebookPage: fn(), publishToInstagram: fn(), sendWhatsappCloud: fn(),
    publishCallback: fn(), publishSocialPost: fn(), maybeSendReviewRequest: fn(),
  };
});
const partial = (names: Array<keyof typeof spies>) => async (orig: () => Promise<unknown>) => ({
  ...((await orig()) as object),
  ...Object.fromEntries(names.map((n) => [n, spies[n]])),
});
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
vi.mock("@/lib/comms/twilio", (orig) =>
  partial(["sendSmsForSubAccount", "sendWhatsappForSubAccount", "sendWhatsappTemplateForSubAccount", "sendSms"])(orig)
);
vi.mock("@/lib/comms/smtp", (orig) => partial(["sendSmtpEmail"])(orig));
vi.mock("@/lib/comms/resend", (orig) => partial(["sendEmail", "sendPlainTextBroadcast"])(orig));
vi.mock("@/lib/comms/meta", (orig) => partial(["sendMetaMessage", "publishToFacebookPage", "publishToInstagram"])(orig));
vi.mock("@/lib/comms/whatsapp/cloud-client", (orig) => partial(["sendWhatsappCloud"])(orig));
vi.mock("@/lib/automations/qstash", async (orig) => ({
  ...(await partial(["publishCallback", "publishSocialPost"])(orig)),
  qstashIsConfigured: () => true,
}));
vi.mock("@/lib/reviews/request", (orig) => partial(["maybeSendReviewRequest"])(orig));
const fired = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("@/lib/workflows/engine", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/workflows/engine");
  return {
    ...real,
    fireWorkflowTrigger: (input: Parameters<typeof real.fireWorkflowTrigger>[0]) => {
      const p = real.fireWorkflowTrigger(input);
      fired.push(p);
      return p;
    },
  };
});

const { dispatchAgentTool } = await import("./agent-dispatch");
const { TRIGGER_LABELS } = await import("@/lib/workflows/catalog");
const { AI_SUITE_CAPABILITIES, availableOn } = await import("@/lib/ai-suite/capabilities");

setupAgentProposalTests();

const FIXTURE_ARGS: Record<string, Record<string, unknown>> = {
  find_contacts: { query: "ann" },
  workspace_stats: {},
  find_deals: { query: "fibre" },
  create_deal: { title: "Fibre 100", value: 500, currency: "ZAR", contactId: "c1", contactName: "Ann", stage: "new" },
  move_deal_stage: { dealId: "d1", dealTitle: "Fibre", stage: "contacted" },
  list_webhooks: {},
  create_workflow: { template: "speed-to-lead" },
  create_contact: { name: "Agent Contact", email: "agent@x.io", phone: "+27821234567" },
  create_task: { title: "Call Ann", contactId: "c1", contactName: "Ann" },
  find_tasks: { filter: "all-open" },
  complete_task: { taskId: "t1", taskTitle: "Follow up" },
  find_events: { range: "all-upcoming" },
  create_event: { title: "Install", date: "2030-01-10", time: "10:00", contactId: "c1", contactName: "Ann" },
  list_members: {},
  // The harness's test-only approval capability: the approval path must queue
  // exactly one proposal and send nothing.
  __test_outbound: { body: "hi" },
};
// An ACTIVE workflow for EVERY trigger type (TRIGGER_LABELS is exhaustive over
// WorkflowTriggerType), with no narrowing config, so any trigger matches.
const TRIGGERS = Object.keys(TRIGGER_LABELS);
const agentCaps = () =>
  AI_SUITE_CAPABILITIES.filter((c) => c.level === "sub-account" && availableOn(c, "agent"));

beforeEach(() => {
  fired.length = 0;
  for (const s of Object.values(spies)) s.mockClear();
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann", email: "ann@x.io",
    phone: "+27821111111", tags: [], customFields: {}, territoryId: "global",
  });
  mem.seed("deals/d1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", title: "Fibre", stageId: "new",
    contactId: "c1", value: 1, currency: "ZAR", territoryId: "global",
  });
  mem.seed("tasks/t1", { subAccountId: "sa1", agencyId: "ag1", title: "Follow up", completed: false, contactId: "c1" });
  TRIGGERS.forEach((type) =>
    mem.seed(`workflows/wf_${type}`, {
      name: `Sends on ${type}`, subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n1",
      trigger: { type, filters: { all: [] } },
      nodes: { n1: { id: "n1", type: "send_sms", config: { body: "Hi {{contact.firstName}}" }, next: null } },
    })
  );
});

/** Every trigger fired so far (awaited or leaked) has settled. */
async function drain() {
  for (let seen = -1; seen !== fired.length; ) {
    seen = fired.length;
    await Promise.allSettled(fired);
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function expectNothingSent() {
  await drain();
  for (const [name, s] of Object.entries(spies)) expect(s, name).not.toHaveBeenCalled();
  expect(mem.list("workflowRuns")).toEqual([]);
}

describe("an agent can never send on its own", () => {
  it("every agent-surfaced capability has a fixture (a new one without one fails here)", () => {
    expect(agentCaps().map((c) => c.name).filter((n) => !(n in FIXTURE_ARGS))).toEqual([]);
  });

  it.each(Object.keys(FIXTURE_ARGS))("%s: dispatches fine and reaches no outbound seam", async (name) => {
    const cap = agentCaps().find((c) => c.name === name);
    expect(cap, `${name} is no longer agent-surfaced; drop its fixture`).toBeDefined();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await dispatchAgentTool(auth, name, FIXTURE_ARGS[name]);
    if (cap!.approval) {
      expect(r).toMatchObject({ ok: true, proposal: { status: "pending" } });
      expect(mem.list("agentProposals")).toHaveLength(1);
    } else {
      expect(r).toMatchObject({ ok: true });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    await expectNothingSent();
  });
});

describe("MUTATION PROOF #2: every awaited trigger site returns its held enrolment", () => {
  // Reverting any one of these service call sites to fire-and-forget (`void`)
  // empties `held` — the dispatch has already resolved, so it cannot wait.
  it.each([
    ["create_contact (contacts-service)", "create_contact", "contact.created"],
    ["create_deal (deals-service create)", "create_deal", "deal.created"],
    ["move_deal_stage (deals-service fireDealTrigger)", "move_deal_stage", "pipeline.stage.changed"],
  ])("%s", async (_label, name, trigger) => {
    const r = (await dispatchAgentTool(auth, name, FIXTURE_ARGS[name])) as { held?: Array<{ workflowName: string }> };
    expect(r.held).toEqual([{ proposalId: expect.any(String), workflowName: `Sends on ${trigger}` }]);
    await expectNothingSent();
  });

  it.each(["won", "lost"])("move_deal_stage to %s holds BOTH the stage-change and the matching deal.won/lost trigger", async (stage) => {
    const r = (await dispatchAgentTool(auth, "move_deal_stage", { dealId: "d1", dealTitle: "Fibre", stage })) as {
      held?: Array<{ workflowName: string }>;
    };
    expect(r.held?.map((h) => h.workflowName).sort()).toEqual(
      [`Sends on deal.${stage}`, "Sends on pipeline.stage.changed"].sort()
    );
    expect(mem.list("agentProposals")).toHaveLength(2);
    await expectNothingSent();
  });
});
