import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { seedAiSmsReady } from "@/test/ai-outbound-sms-fixture";

/**
 * PATCH /api/sub-accounts/:id/workflows/:workflowId — a workflow that will be
 * active with a "Send AI text" step needs AI texts enabled and ready in the
 * workspace. A pre-flight: the step re-checks on every send. Real route,
 * update service and readiness; only tenancy auth is stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u1" }),
}));
vi.mock("@/lib/automations/qstash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/automations/qstash")>()),
  qstashIsConfigured: () => true,
}));

const { PATCH } = await import("./route");

const save = async (body: Record<string, unknown>) => {
  const res = await PATCH(
    new Request("https://app.test/api/sub-accounts/sa1/workflows/wf1", { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "sa1", workflowId: "wf1" }) },
  );
  return { status: res.status, body: (await res.json()) as { error?: string } };
};
const aiStep = { n1: { id: "n1", type: "send_ai_sms", config: { instruction: "Offer a quote." }, next: null } };
const status = () => mem.read("workflows/wf1")?.status;

beforeEach(() => {
  mem.clear();
  vi.stubEnv("OPENROUTER_API_KEY", "or-test");
  seedAiSmsReady(mem.seed, "sa1");
  mem.seed("workflows/wf1", {
    subAccountId: "sa1", agencyId: "ag1", name: "AI opener", status: "draft",
    startNodeId: "n1", nodes: aiStep, trigger: { type: "contact.created", filters: { all: [] } },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("activating a workflow with a Send AI text step", () => {
  it("activates when AI texts are enabled and ready", async () => {
    expect((await save({ status: "active" })).status).toBe(200);
    expect(status()).toBe("active");
  });

  it("refuses while the agency gate is off, and writes nothing", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), aiOutboundSmsEnabledByAgency: false });
    const res = await save({ status: "active" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/switched off for this workspace/);
    expect(status()).toBe("draft");
  });

  it("refuses while a prerequisite is unmet, naming it", async () => {
    mem.seed("subAccounts/sa1/aiAgent/sms", { ...mem.read("subAccounts/sa1/aiAgent/sms"), enabled: false });
    const res = await save({ status: "active" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/the sms ai agent is switched on is missing/);
  });

  it("refuses adding the step to an already active workflow when not ready", async () => {
    mem.seed("workflows/wf1", { ...mem.read("workflows/wf1"), status: "active", nodes: {} });
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), aiOutboundSmsEnabledByAgency: false });
    expect((await save({ nodes: aiStep })).status).toBe(400);
    expect(mem.read("workflows/wf1")?.nodes).toEqual({});
  });

  it("still saves the step on a draft, ready or not", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), aiOutboundSmsEnabledByAgency: false });
    expect((await save({ nodes: aiStep, status: "draft" })).status).toBe(200);
  });
});
