import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { AiSuiteCapability } from "./capabilities";

/**
 * The chat surface (Workspace / Agency Assistant) must never offer or
 * execute an agent-only capability. None exist yet, so agent-only fixtures
 * are pushed into the real registry and driven through the real chat and
 * confirm routes, with only auth, the model call and usage stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({
    uid: "u1",
    email: "a@example.com",
    agencyId: "ag1",
    subAccountRole: "admin",
  }),
  requireAgencyOwnerAny: async () => ({ uid: "u1", email: "a@example.com", agencyId: "ag1" }),
}));
const runAiSuiteTurn = vi.fn();
vi.mock("@/lib/ai-suite/model", () => ({
  aiSuiteIsConfigured: () => true,
  aiSuiteModel: () => "test-model",
  normalizeAiSuiteModelChoice: () => "opus",
  runAiSuiteTurn: (input: unknown) => runAiSuiteTurn(input),
}));
vi.mock("@/lib/ai-suite/usage", () => ({ recordAiSuiteUsage: async () => undefined }));
vi.mock("@/lib/ai-suite/audit", () => ({ recordAiSuiteAction: async () => undefined }));

const {
  AI_SUITE_CAPABILITIES,
  capabilityNamesForLevel,
  getCapability,
  inSubAccount,
  toolsForLevel,
} = await import("./capabilities");
const chat = await import("@/app/api/ai-suite/chat/route");
const confirm = await import("@/app/api/ai-suite/confirm/route");

const admin = { agencyRoleIsOwner: true, subAccountRole: "admin" };
const injected: AiSuiteCapability[] = [];
function injectAgentOnly(name: string, readonly: boolean): AiSuiteCapability {
  const cap: AiSuiteCapability = {
    name,
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly,
    surfaces: ["agent"],
    menuLabel: name,
    description: name,
    parameters: { type: "object", properties: {} },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => name,
    execute: vi.fn(async () => ({ resultText: "ran" })),
  };
  AI_SUITE_CAPABILITIES.push(cap);
  injected.push(cap);
  return cap;
}

const post = (body: unknown) =>
  new Request("http://localhost/api/ai-suite", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", aiSuiteEnabledByAgency: true, name: "W" });
  runAiSuiteTurn.mockReset();
});

afterEach(() => {
  for (const cap of injected.splice(0)) {
    AI_SUITE_CAPABILITIES.splice(AI_SUITE_CAPABILITIES.indexOf(cap), 1);
  }
});

describe("agent-only capabilities stay off the chat surface", () => {
  it("toolsForLevel and capabilityNamesForLevel never offer them", () => {
    injectAgentOnly("__agent_lookup", true);
    injectAgentOnly("__agent_write", false);
    const tools = toolsForLevel("sub-account", admin).map((t) => t.function.name);
    const { actions, lookups } = capabilityNamesForLevel("sub-account", admin);
    const menu = [...actions, ...lookups].map((i) => i.name);
    for (const name of ["__agent_lookup", "__agent_write"]) {
      expect(tools).not.toContain(name);
      expect(menu).not.toContain(name);
    }
    // Sanity: the filter isn't dropping everything.
    expect(tools).toContain("find_contacts");
  });

  it("the confirm route refuses one by name, without executing it", async () => {
    const cap = injectAgentOnly("__agent_write", false);
    const res = await confirm.POST(
      post({ level: "sub-account", subAccountId: "sa1", capability: "__agent_write", args: {} })
    );
    expect(res.status).toBe(400);
    expect(cap.execute).not.toHaveBeenCalled();
  });

  it("the chat route neither runs a lookup nor proposes a write the model names", async () => {
    const lookup = injectAgentOnly("__agent_lookup", true);
    const write = injectAgentOnly("__agent_write", false);
    for (const name of ["__agent_lookup", "__agent_write"]) {
      runAiSuiteTurn.mockResolvedValueOnce({
        text: "calling",
        toolCall: { id: "call_1", name, args: {} },
      });
      const res = await chat.POST(
        post({ level: "sub-account", subAccountId: "sa1", messages: [{ role: "user", content: "go" }] })
      );
      expect(res.status).toBe(200);
      expect((await res.json()).type).toBe("message");
    }
    expect(lookup.execute).not.toHaveBeenCalled();
    expect(write.execute).not.toHaveBeenCalled();
    // One model call per request: no lookup hop was taken.
    expect(runAiSuiteTurn).toHaveBeenCalledTimes(2);
    const offered = (runAiSuiteTurn.mock.calls[0]![0] as { tools: Array<{ function: { name: string } }> })
      .tools.map((t) => t.function.name);
    expect(offered).not.toContain("__agent_lookup");
  });
});

describe("agency variants keep their base's surfaces", () => {
  it("an agent-only base's _in_sub_account variant never reaches the agency chat", () => {
    const base = injectAgentOnly("__agent_base", false);
    const variant = inSubAccount(base);
    AI_SUITE_CAPABILITIES.push(variant);
    injected.push(variant);
    expect(variant.surfaces).toEqual(["agent"]);
    const owner = { agencyRoleIsOwner: true };
    const tools = toolsForLevel("agency", owner).map((t) => t.function.name);
    const { actions, lookups } = capabilityNamesForLevel("agency", owner);
    const menu = [...actions, ...lookups].map((i) => i.name);
    expect(tools).not.toContain("__agent_base_in_sub_account");
    expect(menu).not.toContain("__agent_base_in_sub_account");
    // Sanity: the agency list isn't empty.
    expect(tools).toContain("find_contacts_in_sub_account");
  });

  it("the delegation loop carried a chat-only base's surfaces onto its variant", () => {
    expect(getCapability("create_webhook_in_sub_account")!.surfaces).toEqual(["chat"]);
  });
});

describe("registry invariants", () => {
  // Vacuous today: no capability sets `approval` yet. It becomes live in PR3,
  // when the approvals UI renders `preview` for every queued proposal.
  it("every capability with an approval class has a preview", () => {
    const missing = AI_SUITE_CAPABILITIES.filter((c) => (c.approval || c.approvalFor) && !c.preview).map(
      (c) => c.name
    );
    expect(missing).toEqual([]);
  });

  // Vacuous today (no shipped approval capability yet): each one must say
  // what it targets, or its row could not be territory-scoped.
  it("every approval capability declares an approvalTarget", () => {
    expect(
      AI_SUITE_CAPABILITIES.filter((c) => (c.approval || c.approvalFor) && !c.approvalTarget).map((c) => c.name)
    ).toEqual([]);
  });

  // Every approval capability adds sample args here; a missing entry fails
  // the test. They target the contact seeded below.
  const PREVIEW_SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
    update_contact_channels: { contactId: "c_sample", phone: "+27821234567", email: "new@x.io" },
    delete_contact: { contactId: "c_sample" },
    delete_company: { companyId: "co_sample" },
    set_bot_mode: { conversationId: "c_sample", mode: "auto" },
    send_message: { conversationId: "c_sample", channel: "sms", body: "Hello" },
    schedule_message: { conversationId: "c_sample", channel: "sms", body: "Hello", sendAt: "2030-01-10T08:00:00.000Z" },
    send_whatsapp_template: { conversationId: "c_sample", templateId: "tpl_sample", variables: { "1": "Tuesday" } },
    update_workflow: { workflowId: "wf_active", name: "Renamed" },
    set_workflow_status: { workflowId: "wf_paused", status: "active" },
    delete_workflow: { workflowId: "wf_paused" },
    delete_deal: { dealId: "d_sample" },
    mark_deal_completed: { dealId: "d_won" },
    delete_pipeline: { pipelineId: "p_sample" },
    delete_custom_field: { fieldId: "cf_sample" },
    delete_custom_field_folder: { folderId: "fo_sample" },
    delete_product: { productId: "pr_sample" },
    update_product: { productId: "pr_sold", unitPriceCents: 200 },
    delete_snippet: { snippetId: "sn_sample" },
  };
  /** The approval class a capability carries for its sample args. */
  const approvalOf = async (c: (typeof AI_SUITE_CAPABILITIES)[number]) => {
    const { buildPreviewContext } = await import("@/lib/api/agent-context");
    return c.approvalFor ? c.approvalFor(PREVIEW_SAMPLE_ARGS[c.name] ?? {}, buildPreviewContext("ag1", "sa1")) : c.approval;
  };
  const withApproval = async (keep: (a: Awaited<ReturnType<typeof approvalOf>>) => boolean) => {
    const out = [];
    for (const c of AI_SUITE_CAPABILITIES) if (keep(await approvalOf(c))) out.push(c);
    return out;
  };
  const seedSample = () => {
    mem.seed("contacts/c_sample", {
      subAccountId: "sa1", agencyId: "ag1", name: "Sample", phone: "+27820000000", email: "old@x.io", territoryId: "global",
    });
    mem.seed("companies/co_sample", { subAccountId: "sa1", agencyId: "ag1", name: "Sample Co" });
    mem.seed("conversations/c_sample", { subAccountId: "sa1", agencyId: "ag1", contactId: "c_sample", contactName: "Sample", botMode: "suggest" });
    mem.seed("subAccounts/sa1", {
      ...mem.read("subAccounts/sa1"), whatsappEnabledByAgency: true,
      twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, whatsappFromNumber: "+27100000000" },
    });
    mem.seed("subAccounts/sa1/whatsappTemplates/tpl_sample", {
      subAccountId: "sa1", agencyId: "ag1", name: "sample", displayName: "Sample", language: "en", status: "approved", contentSid: "HX1",
      body: "See you {{1}}.", variables: [{ position: 1, label: "Day", sampleValue: "Monday", source: "manual", mergeTag: null }],
    });
    for (const [id, status] of [["wf_active", "active"], ["wf_paused", "paused"]]) {
      mem.seed(`workflows/${id}`, {
        subAccountId: "sa1", agencyId: "ag1", name: "Sample flow", status, startNodeId: "n1",
        trigger: { type: "contact.created", filters: { all: [] } },
        nodes: { n1: { id: "n1", type: "send_sms", config: { body: "Hi" }, next: null } },
      });
    }
    mem.seed("deals/d_sample", { subAccountId: "sa1", agencyId: "ag1", title: "Sample deal", stageId: "new", territoryId: "global" });
    mem.seed("deals/d_won", { subAccountId: "sa1", agencyId: "ag1", title: "Won deal", stageId: "won", contactId: "c_sample", territoryId: "global" });
    mem.seed("subAccounts/sa1/customFields/cf_sample", { subAccountId: "sa1", agencyId: "ag1", entity: "contact", key: "k", label: "K", type: "text", options: [], required: false, order: 0 });
    mem.seed("subAccounts/sa1/customFieldFolders/fo_sample", { subAccountId: "sa1", agencyId: "ag1", name: "F", entity: "contact", order: 0 });
    mem.seed("products/pr_sample", { subAccountId: "sa1", agencyId: "ag1", name: "P", unitPriceCents: 100, currency: "USD", active: true });
    mem.seed("products/pr_sold", { subAccountId: "sa1", agencyId: "ag1", name: "Sold", unitPriceCents: 100, currency: "USD", active: true });
    mem.seed("subAccounts/sa1/checkoutPages/cp_sample", { subAccountId: "sa1", name: "Offer", productId: "pr_sold", bumpProductIds: [] });
    mem.seed("snippets/sn_sample", { subAccountId: "sa1", agencyId: "ag1", name: "S", type: "text", body: "Hi", subject: null, folder: null });
    mem.seed("subAccounts/sa1/pipelines/p_sample", { subAccountId: "sa1", agencyId: "ag1", name: "Sample", isDefault: false, stages: [{ id: "a", label: "A", tone: "" }] });
  };

  it("every approval capability's preview is pure: the same under two callers and the neutral preview ctx", async () => {
    const { buildPreviewContext } = await import("@/lib/api/agent-context");
    const tenant = { agencyId: "ag1", subAccountId: "sa1" };
    const admin = { ...tenant, uid: "u_admin", email: "admin@x.io", displayName: "A", subAccountRole: "admin" };
    const rep = { ...tenant, uid: "u_rep", email: "rep@x.io", displayName: "R", subAccountRole: "collaborator" };
    seedSample();
    for (const cap of await withApproval((a) => !!a)) {
      const args = PREVIEW_SAMPLE_ARGS[cap.name];
      expect(args, `${cap.name} needs PREVIEW_SAMPLE_ARGS`).toBeDefined();
      const neutral = await cap.preview!(buildPreviewContext("ag1", "sa1"), args!);
      expect(await cap.preview!(rep, args!)).toEqual(neutral);
      expect(await cap.preview!(admin, args!)).toEqual(neutral);
    }
  });

  // Every OUTBOUND or CHANNEL_CHANGE approval capability's preview must pin
  // its target (dispatch and approve refuse otherwise).
  it("every outbound / channel_change approval capability's sample preview pins a non-empty target", async () => {
    const { buildPreviewContext } = await import("@/lib/api/agent-context");
    seedSample();
    const pinning = await withApproval((a) => a === "outbound" || a === "channel_change");
    expect(pinning.map((c) => c.name)).toEqual(expect.arrayContaining(["update_contact_channels", "set_bot_mode"]));
    for (const cap of pinning) {
      const p = await cap.preview!(buildPreviewContext("ag1", "sa1"), PREVIEW_SAMPLE_ARGS[cap.name] ?? {});
      expect(Array.isArray(p) ? {} : (p.pinned ?? {}), `${cap.name} must pin its target`).not.toEqual({});
    }
  });
});
