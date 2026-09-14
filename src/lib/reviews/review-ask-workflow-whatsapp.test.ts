import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { getStarterTemplate } from "@/lib/comms/whatsapp/starter-templates";

/**
 * SP5 d1 — WhatsApp workflow steps as review asks. Real `runStep` on an
 * in-memory Firestore; readiness and the two WhatsApp dispatchers are
 * doubles. Detection reads what actually went out: the template's filled
 * body and button URLs when a template (or its in-window buttons) was sent,
 * the free text otherwise.
 */

const mem = createMemoryFirestore();
const dispatchWhatsappSend = vi.fn();
const dispatchWhatsappTemplateSend = vi.fn();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({ qstashIsConfigured: () => true, publishCallback: async () => ({ messageId: "q1" }) }));
vi.mock("@/lib/comms/whatsapp/send-dispatch", () => ({ dispatchWhatsappSend: (...a: unknown[]) => dispatchWhatsappSend(...a) }));
vi.mock("@/lib/comms/whatsapp/template-dispatch", () => ({
  dispatchWhatsappTemplateSend: (...a: unknown[]) => dispatchWhatsappTemplateSend(...a),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({
  checkWhatsappReadiness: async () => ({ ready: true, provider: "cloud", sender: { phoneNumber: "+15550002" } }),
}));
vi.mock("@/lib/comms/whatsapp/template-registrations", () => ({ isTemplateApprovedFor: () => true }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));
vi.mock("@/lib/server/usage-meter", () => ({ checkQuota: async () => ({ allowed: true }), UsageQuotaExceededError: class extends Error {} }));

const { runStep } = await import("@/lib/workflows/engine");

const REVIEW_URL = "https://g.page/r/velocity/review";
const rows = () => mem.list("subAccounts/sa1/reviewRequests");
const starter = getStarterTemplate("review_request")!;

function seedRun(node: Record<string, unknown>) {
  mem.seed("workflows/wf1", {
    name: "Ask", subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n1", createdByUid: "u_owner",
    trigger: { type: "contact.tag.added", filters: { all: [] } }, nodes: { n1: { id: "n1", next: null, ...node } },
  });
  mem.seed("workflowRuns/run1", {
    id: "run1", subAccountId: "sa1", agencyId: "ag1", workflowId: "wf1", contactId: "c1",
    status: "running", currentNodeId: "n1", history: [], context: {},
  });
}

function seedTemplate(id: string, over: Record<string, unknown>) {
  mem.seed(`subAccounts/sa1/whatsappTemplates/${id}`, {
    name: id, displayName: id, category: "UTILITY", language: "en", body: "Hi {{1}}, all done.",
    variables: [{ position: 1, label: "First name", sampleValue: "Ben", source: "merge_tag", mergeTag: "contact.firstName" }],
    status: "approved", contentSid: null, ...over,
  });
}

beforeEach(() => {
  mem.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  dispatchWhatsappSend.mockReset().mockResolvedValue({ ok: true, messageId: "wamid.1", sentAs: "text" });
  dispatchWhatsappTemplateSend.mockReset().mockResolvedValue({ ok: true, messageId: "wamid.2" });
  mem.seed("agencies/ag1", { ownerUid: "u_owner" });
  mem.seed("subAccounts/sa1", {
    name: "Velocity", agencyId: "ag1", whatsappEnabledByAgency: true, googleReviewConfig: { reviewUrl: REVIEW_URL },
  });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Thandi", phone: "+27821234567", tags: [], customFields: {} });
});

describe("whatsapp_template step", () => {
  it("the review_request starter is a review ask even with the link in a manual variable", async () => {
    seedTemplate("review_request", {
      body: starter.body,
      variables: starter.variables,
    });
    seedRun({ type: "whatsapp_template", config: { templateId: "review_request", manualValues: { 3: "https://example.test/thanks" } } });
    await runStep("run1", "n1");
    expect(dispatchWhatsappTemplateSend).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ channel: "whatsapp", source: "workflow", status: "sent", messageSid: "wamid.2" });
  });

  it("a template whose URL button is the review link is a review ask", async () => {
    seedTemplate("thanks_tpl", { buttons: [{ type: "url", text: "Leave a review", url: REVIEW_URL }] });
    seedRun({ type: "whatsapp_template", config: { templateId: "thanks_tpl" } });
    await runStep("run1", "n1");
    expect(rows()).toHaveLength(1);
  });

  it("any other template is not", async () => {
    seedTemplate("thanks_tpl", {});
    seedRun({ type: "whatsapp_template", config: { templateId: "thanks_tpl" } });
    await runStep("run1", "n1");
    expect(dispatchWhatsappTemplateSend).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([]);
  });

  it("a refused template send of a review ask is logged failed with the dispatcher's kind", async () => {
    dispatchWhatsappTemplateSend.mockResolvedValueOnce({ ok: false, error: "WA_TEMPLATE_NOT_APPROVED" });
    seedTemplate("review_request", { body: starter.body, variables: starter.variables });
    seedRun({ type: "whatsapp_template", config: { templateId: "review_request", manualValues: { 3: REVIEW_URL } } });
    await runStep("run1", "n1");
    expect(rows()[0]).toMatchObject({ status: "failed", failureKind: "WA_TEMPLATE_NOT_APPROVED" });
  });
});

describe("send_whatsapp step", () => {
  it("free text carrying the link, sent as text, is a review ask", async () => {
    seedRun({ type: "send_whatsapp", config: { body: `Thanks! Review us: ${REVIEW_URL}` } });
    await runStep("run1", "n1");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ channel: "whatsapp", status: "sent", messageSid: "wamid.1" });
  });

  it("when the window made it go as a template without the link, it is not", async () => {
    dispatchWhatsappSend.mockResolvedValueOnce({ ok: true, messageId: "wamid.3", sentAs: "template" });
    seedTemplate("thanks_tpl", {});
    seedRun({ type: "send_whatsapp", config: { body: `Thanks! Review us: ${REVIEW_URL}`, templateId: "thanks_tpl" } });
    await runStep("run1", "n1");
    expect(rows()).toEqual([]);
  });
});
