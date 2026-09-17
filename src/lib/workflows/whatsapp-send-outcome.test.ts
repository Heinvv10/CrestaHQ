import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { markProviderAttempted } from "@/lib/comms/provider-attempt";
import { UsageQuotaExceededError } from "@/lib/server/usage-meter";

/**
 * What a workflow WhatsApp send leaves behind, driven through the real
 * `runStep` → node executor → dispatcher → Cloud client on an in-memory
 * Firestore. Only the edges are faked: the WABA credential read, QStash, and
 * the network (`fetch` to Graph).
 *
 * Two properties:
 *  - a template sent by a workflow shows in the contact's thread and inbox,
 *    as a manual template send does;
 *  - a send that definitely did not go out stops the run (`failed`), while
 *    one that may have gone out continues to the next node.
 */

const mem = createMemoryFirestore();
let failRecordWrite = false;
const scheduled: string[] = [];

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () =>
    failRecordWrite
      ? {
          ...mem.db,
          collection: (path: string) =>
            path.endsWith("/whatsappMessages")
              ? {
                  doc: () => ({
                    set: async () => {
                      throw new Error("storage unavailable");
                    },
                  }),
                }
              : mem.db.collection(path),
        }
      : mem.db,
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async (input: { body: { nodeId: string } }) => {
    scheduled.push(input.body.nodeId);
    return { messageId: "q1" };
  },
}));
vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  whatsappCloudIsConfigured: async () => true,
  getWabaCreds: async () => ({ phoneNumberId: "pn_1", wabaId: "waba_1", accessToken: "tok" }),
}));

// Twilio's client is the other provider edge. What it throws decides the run:
// marked as attempted (the request left) or not (refused before it).
let twilioThrows: () => unknown = () => undefined;
vi.mock("@/lib/comms/twilio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/twilio")>()),
  subAccountWhatsappIsConfigured: () => true,
  sendWhatsappTemplateForSubAccount: async () => {
    throw twilioThrows();
  },
  sendWhatsappForSubAccount: async () => {
    throw twilioThrows();
  },
}));

const { runStep } = await import("./engine");

type Graph = (req: Record<string, unknown>) => Response | Promise<Response>;
const requests: Record<string, unknown>[] = [];
function graph(respond: Graph) {
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const req = JSON.parse(init.body as string) as Record<string, unknown>;
    requests.push(req);
    return respond(req);
  });
}
const accepted: Graph = () =>
  new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });

function seedWorkflow(first: Record<string, unknown>) {
  mem.seed("workflows/wf1", {
    name: "Install check",
    subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n1",
    createdByUid: "u_owner",
    trigger: { type: "contact.tag.added", filters: { all: [] } },
    nodes: {
      n1: { id: "n1", ...first, next: "n2" },
      n2: { id: "n2", type: "add_tag", config: { tag: "checked" }, next: null },
    },
  });
}
const templateNode = { type: "whatsapp_template", config: { templateId: "tpl1" } };
const freeFormNode = { type: "send_whatsapp", config: { body: "Hi {{contact.firstName}}" } };

beforeEach(() => {
  mem.clear();
  failRecordWrite = false;
  scheduled.length = 0;
  requests.length = 0;
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("users/u_owner", { displayName: "Owner", email: "owner@example.com" });
  mem.seed("subAccounts/sa1", {
    name: "Velocity", agencyId: "ag1",
    whatsappEnabledByAgency: true,
    whatsappProvider: "cloud",
    whatsappCloudMeta: { phoneNumberId: "pn_1", displayPhoneNumber: "+27687608830" },
  });
  mem.seed("subAccounts/sa1/whatsappTemplates/tpl1", {
    name: "install_check",
    displayName: "Install check",
    language: "en",
    body: "Hi {{1}}, is your fibre working?",
    variables: [{ position: 1, source: "merge_tag", mergeTag: "contact.firstName" }],
    registrations: { cloud: { externalId: "meta_1", status: "approved", rejectionReason: null } },
  });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi M",
    phone: "+27821234567", tags: [], customFields: {},
  });
  mem.seed("workflowRuns/run1", {
    id: "run1",
    workflowId: "wf1", contactId: "c1", subAccountId: "sa1", agencyId: "ag1",
    status: "running", currentNodeId: "n1", history: [], context: {},
  });
});
afterEach(() => vi.unstubAllGlobals());

const run = () => mem.read("workflowRuns/run1") as { status: string; history: Array<{ result: string }> };

describe("a workflow template send is visible in the CRM", () => {
  it("writes the rendered template to the thread and upserts the conversation", async () => {
    seedWorkflow(templateNode);
    graph(accepted);
    await runStep("run1", "n1");

    expect(requests[0].type).toBe("template");
    expect(mem.read("contacts/c1/whatsappMessages/wamid.1")).toMatchObject({
      agencyId: "ag1",
      subAccountId: "sa1",
      contactId: "c1",
      direction: "outbound",
      status: "sent",
      body: "Hi Thandi, is your fibre working?",
      to: "+27821234567",
      twilioMessageSid: "wamid.1",
      sentByUid: null,
    });
    expect(mem.read("conversations/c1")).toMatchObject({
      subAccountId: "sa1",
      lastDirection: "outbound",
      lastChannel: "whatsapp",
      lastMessagePreview: "Hi Thandi, is your fibre working?",
    });
    expect(run().history).toMatchObject([{ result: "ok" }]);
    expect(scheduled).toEqual(["n2"]);
  });

  it("continues the run when the record write fails after a real send", async () => {
    seedWorkflow(templateNode);
    graph(accepted);
    failRecordWrite = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runStep("run1", "n1");
    } finally {
      warn.mockRestore();
    }
    expect(requests).toHaveLength(1);
    expect(run().history).toMatchObject([{ result: "sent:message_record_failed" }]);
    expect(run().status).not.toBe("failed");
    expect(scheduled).toEqual(["n2"]);
  });
});

describe("a definitely-unsent WhatsApp stops the run", () => {
  const rejected: Graph = () =>
    new Response(JSON.stringify({ error: { message: "invalid parameter" } }), { status: 400 });

  it("template: Meta rejects the request (4xx)", async () => {
    seedWorkflow(templateNode);
    graph(rejected);
    await runStep("run1", "n1");
    expect(run().status).toBe("failed");
    expect(run().history[0].result).toMatch(/^error:WhatsApp Cloud 400/);
    expect(scheduled).toEqual([]);
    expect(mem.list("contacts/c1/whatsappMessages")).toEqual([]);
    expect(mem.read("contacts/c1/activities/run_run1_automation_failed")).toMatchObject({
      type: "automation_failed",
    });
  });

  it("template: not approved on the workspace's rail, refused before dispatch", async () => {
    mem.seed("subAccounts/sa1/whatsappTemplates/tpl1", {
      ...mem.read("subAccounts/sa1/whatsappTemplates/tpl1"),
      registrations: {},
    });
    seedWorkflow(templateNode);
    graph(accepted);
    await runStep("run1", "n1");
    expect(requests).toEqual([]);
    expect(run().status).toBe("failed");
    expect(run().history[0].result).toBe("error:template_not_approved");
    expect(scheduled).toEqual([]);
  });

  it("free-form: window shut and no template, refused before dispatch", async () => {
    seedWorkflow(freeFormNode);
    graph(accepted);
    await runStep("run1", "n1");
    expect(requests).toEqual([]);
    expect(run().status).toBe("failed");
    expect(scheduled).toEqual([]);
  });
});

describe("an ambiguous WhatsApp failure continues the run", () => {
  // The request may have reached Meta; the customer may have the message.
  const dropped: Graph = () => {
    throw new TypeError("fetch failed");
  };

  it("template", async () => {
    seedWorkflow(templateNode);
    graph(dropped);
    await runStep("run1", "n1");
    expect(run().history[0].result).toBe("error:fetch failed");
    expect(run().status).not.toBe("failed");
    expect(scheduled).toEqual(["n2"]);
  });

  it("free-form", async () => {
    mem.seed("contacts/c1/whatsappMessages/in1", {
      direction: "inbound", createdAt: Timestamp.now(),
    });
    seedWorkflow(freeFormNode);
    graph(dropped);
    await runStep("run1", "n1");
    expect(requests).toHaveLength(1);
    expect(run().history[0].result).toBe("error:fetch failed");
    expect(run().status).not.toBe("failed");
    expect(scheduled).toEqual(["n2"]);
  });
});

describe("a thrown send on the Twilio rail", () => {
  beforeEach(() => {
    mem.seed("subAccounts/sa1", {
      name: "Velocity", agencyId: "ag1",
      whatsappEnabledByAgency: true,
      whatsappProvider: "twilio",
      twilioConfig: { whatsappFromNumber: "+15550001" },
    });
    mem.seed("subAccounts/sa1/whatsappTemplates/tpl1", {
      ...mem.read("subAccounts/sa1/whatsappTemplates/tpl1"),
      registrations: { twilio: { externalId: "HX1", status: "approved", rejectionReason: null } },
    });
    // An open window, so the free-form node sends text through Twilio.
    mem.seed("contacts/c1/whatsappMessages/in1", {
      direction: "inbound", createdAt: Timestamp.now(),
    });
  });

  it.each([
    ["template", templateNode],
    ["free-form", freeFormNode],
  ])("%s: continues when the provider was called", async (_name, node) => {
    twilioThrows = () => markProviderAttempted(new Error("socket hang up"));
    seedWorkflow(node);
    await runStep("run1", "n1");
    expect(run().history[0].result).toBe("error:socket hang up");
    expect(run().status).not.toBe("failed");
    expect(scheduled).toEqual(["n2"]);
  });

  it.each([
    ["template", templateNode],
    ["free-form", freeFormNode],
  ])("%s: stops when it failed before the provider was called", async (_name, node) => {
    twilioThrows = () => new Error("WhatsApp is not configured for this sub-account.");
    seedWorkflow(node);
    await runStep("run1", "n1");
    expect(run().status).toBe("failed");
    expect(scheduled).toEqual([]);
  });

  it.each([
    ["template", templateNode],
    ["free-form", freeFormNode],
  ])("%s: stops on an exhausted quota, logged as a skip", async (_name, node) => {
    twilioThrows = () => new UsageQuotaExceededError("whatsappMessages");
    seedWorkflow(node);
    await runStep("run1", "n1");
    expect(run().history[0].result).toBe("skipped:quota");
    expect(run().status).toBe("failed");
    expect(scheduled).toEqual([]);
  });
});
