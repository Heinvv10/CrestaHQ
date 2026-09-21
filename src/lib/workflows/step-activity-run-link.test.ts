import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Every timeline row a workflow step writes on the contact carries the run
 * it came from (`meta.workflowId` + `meta.runId`), so the Activity tab can
 * link "View run". Real `runStep` on an in-memory Firestore; only the
 * outbound providers are stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => ({ messageId: "q1" }),
}));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => true,
  tenantFrom: () => "sender@tenant.test",
  sendEmail: async () => ({ id: "email_1" }),
}));
vi.mock("@/lib/comms/twilio", () => ({
  smsIsConfigured: () => true,
  subAccountTwilioIsConfigured: () => false,
  sendSmsForSubAccount: async () => ({ sid: "SM_1", mode: "shared" }),
  sendWhatsappForSubAccount: async () => ({}),
  sendWhatsappTemplateForSubAccount: async () => ({}),
  SmsRecipientUnsubscribedError: class extends Error {},
}));
vi.mock("@/lib/agency/policy", () => ({ agencyAllowsSharedSms: async () => true }));
vi.mock("@/lib/server/usage-meter", () => ({
  checkQuota: async () => ({ allowed: true }),
  UsageQuotaExceededError: class extends Error {},
}));
vi.mock("@/lib/automations/unsubscribe-token", () => ({
  buildUnsubscribeUrl: () => "https://app.test/u/x",
}));

const { runStep } = await import("./engine");

function seedRun(node: Record<string, unknown>) {
  mem.seed("workflows/wf1", {
    name: "Nudge", subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner",
    trigger: { type: "contact.tag.added", filters: { all: [] } },
    nodes: { n1: { id: "n1", next: null, ...node } },
  });
  mem.seed("workflowRuns/run1", {
    id: "run1", subAccountId: "sa1", agencyId: "ag1", workflowId: "wf1",
    contactId: "c1", status: "running", currentNodeId: "n1", history: [], context: {},
  });
}

beforeEach(() => {
  mem.clear();
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("users/u_owner", { displayName: "Owner", email: "owner@example.com" });
  mem.seed("subAccounts/sa1", { name: "Velocity", agencyId: "ag1" });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi",
    email: "thandi@example.com", phone: "+27821234567", tags: [], customFields: {},
  });
});

const rowOfType = (type: string) =>
  mem.list("contacts/c1/activities").find((a) => a.type === type);

describe("workflow step rows link to their run", () => {
  it("send_email → email_sent carries workflowId + runId", async () => {
    seedRun({ type: "send_email", config: { subject: "Hi", body: "Hello" } });
    await runStep("run1", "n1");
    expect(rowOfType("email_sent")?.meta).toMatchObject({
      messageId: "email_1", workflowId: "wf1", runId: "run1",
    });
  });

  it("send_sms → sms_sent carries workflowId + runId", async () => {
    seedRun({ type: "send_sms", config: { body: "Hello" } });
    await runStep("run1", "n1");
    expect(rowOfType("sms_sent")?.meta).toMatchObject({
      sid: "SM_1", workflowId: "wf1", runId: "run1",
    });
  });

  it("create_task → task_created carries workflowId + runId", async () => {
    seedRun({ type: "create_task", config: { title: "Call back", dueInDays: 1 } });
    await runStep("run1", "n1");
    const row = rowOfType("task_created");
    expect(row?.meta).toMatchObject({ workflowId: "wf1", runId: "run1" });
    expect(mem.read(`tasks/${(row?.meta as { taskId: string }).taskId}`)).toMatchObject({
      title: "Call back", contactId: "c1",
    });
  });
});
