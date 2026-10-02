import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, mem, setupDispatchTests } from "@/test/agent-dispatch-harness";

/**
 * submit_whatsapp_template through the real dispatch and the submission the
 * submit route shares (template-submit.ts): it submits on the rail the
 * workspace sends on, records the registration on that rail, queues the
 * approval poll, and refuses everything the route refuses. The providers and
 * QStash are stubbed at their modules.
 */

const createCloudTemplate = vi.hoisted(() => vi.fn());
const createContentTemplate = vi.hoisted(() => vi.fn());
const submitForWhatsappApproval = vi.hoisted(() => vi.fn());
const publishCallback = vi.hoisted(() => vi.fn());

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-dispatch-harness")).adminMock());
vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  getWabaCreds: async () => ({ phoneNumberId: "pn_1", wabaId: "waba_1", accessToken: "tok" }),
}));
vi.mock("@/lib/comms/whatsapp/cloud-templates", async (orig) => ({ ...((await orig()) as object), createCloudTemplate }));
vi.mock("@/lib/comms/whatsapp/templates-api", () => ({
  createContentTemplate,
  submitForWhatsappApproval,
  WhatsappContentError: class extends Error {},
}));
vi.mock("@/lib/automations/qstash", () => ({ qstashIsConfigured: () => true, publishCallback }));

const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { CloudTemplateError } = await import("@/lib/comms/whatsapp/cloud-templates");

setupDispatchTests();
const call = (args: unknown) => dispatchAgentTool(auth, "submit_whatsapp_template", args);
const PATH = "subAccounts/sa1/whatsappTemplates/t1";

const TEMPLATE = {
  subAccountId: "sa1", agencyId: "ag1", name: "", displayName: "Install Day!", category: "UTILITY", language: "en",
  body: "Hi {{1}}", variables: [{ position: 1, label: "Name", sampleValue: "Thandi", source: "manual", mergeTag: null }],
  buttons: [], contentSid: null, status: "draft", rejectionReason: null,
};
const CLOUD = { whatsappProvider: "cloud", whatsappCloudMeta: { phoneNumberId: "pn_1", displayPhoneNumber: "+27784356159" } };
const TWILIO = {
  whatsappProvider: "twilio",
  twilioConfig: { enabled: true, accountSid: "AC1", authToken: "tok", whatsappFromNumber: "+27110000000" },
};
const setSub = (over: Record<string, unknown>) =>
  mem.seed("subAccounts/sa1", { agencyId: "ag1", agentApiEnabledByAgency: true, timezone: "UTC", whatsappEnabledByAgency: true, ...over });

beforeEach(() => {
  createCloudTemplate.mockReset().mockResolvedValue({ id: "meta_1" });
  createContentTemplate.mockReset().mockResolvedValue({ contentSid: "HX1" });
  submitForWhatsappApproval.mockReset().mockResolvedValue(undefined);
  publishCallback.mockReset().mockResolvedValue({ messageId: "m1" });
  setSub(CLOUD);
  mem.seed(PATH, TEMPLATE);
});

describe("submit_whatsapp_template", () => {
  it("cloud: submits to Meta, records the cloud registration, queues the first poll", async () => {
    const r = await call({ templateId: "t1" });
    expect(r).toMatchObject({ ok: true, ref: { kind: "whatsappTemplate", id: "t1" } });
    expect((r as { resultText: string }).resultText).toMatch(/Submitted “install_day” to Meta for review on the cloud rail/);
    expect(createCloudTemplate).toHaveBeenCalledWith(expect.objectContaining({ wabaId: "waba_1" }), expect.objectContaining({ name: "install_day", body: "Hi {{1}}" }));
    expect(createContentTemplate).not.toHaveBeenCalled();
    expect(mem.read(PATH)).toMatchObject({ status: "pending", name: "install_day", registrations: { cloud: { externalId: "meta_1", status: "pending" } } });
    expect(publishCallback).toHaveBeenCalledWith(expect.objectContaining({
      pathname: "/api/sub-accounts/sa1/whatsapp-templates/poll",
      body: { subAccountId: "sa1", templateId: "t1", contentSid: "meta_1" },
      deduplicationId: "watpl_sa1_t1_meta_1_0",
    }));
    expect(mem.list("auditEvents")).toEqual([
      expect.objectContaining({ action: "agent.write", target: { type: "whatsappTemplate", id: "t1" } }),
    ]);
  });

  it("a resubmit's first poll has its own dedup id, not the earlier submission's", async () => {
    await call({ templateId: "t1" });
    mem.seed(PATH, { ...mem.read(PATH)!, status: "rejected" });
    createCloudTemplate.mockResolvedValue({ id: "meta_2" });
    await call({ templateId: "t1" });
    expect(publishCallback.mock.calls.map(([o]) => (o as { deduplicationId: string }).deduplicationId)).toEqual([
      "watpl_sa1_t1_meta_1_0",
      "watpl_sa1_t1_meta_2_0",
    ]);
  });

  it("twilio: creates the Content resource and requests approval through it", async () => {
    setSub(TWILIO);
    expect(await call({ templateId: "t1" })).toMatchObject({ ok: true });
    expect(createContentTemplate).toHaveBeenCalledWith(expect.objectContaining({ accountSid: "AC1", friendlyName: "install_day", variables: { 1: "Thandi" } }));
    expect(submitForWhatsappApproval).toHaveBeenCalledWith(expect.objectContaining({ contentSid: "HX1", category: "UTILITY" }));
    expect(mem.read(PATH)).toMatchObject({ status: "pending", contentSid: "HX1", registrations: { twilio: { externalId: "HX1" } } });
  });

  it("resubmits a rejected template", async () => {
    mem.seed(PATH, { ...TEMPLATE, status: "rejected", rejectionReason: "policy" });
    expect(await call({ templateId: "t1" })).toMatchObject({ ok: true });
    expect(mem.read(PATH)).toMatchObject({ status: "pending", rejectionReason: null });
  });

  it.each([
    ["an approved template", () => mem.seed(PATH, { ...TEMPLATE, status: "approved" }), "A approved template can't be submitted again."],
    ["a pending template", () => mem.seed(PATH, { ...TEMPLATE, status: "pending" }), "A pending template can't be submitted again."],
    ["the bridge rail", () => setSub({ whatsappSenders: [{ id: "b", label: "Own", provider: "bridge", phoneNumber: "+27784356159", isDefault: true }] }), /bridge provider has no templates/],
    ["Twilio not configured", () => setSub({ ...TWILIO, twilioConfig: { ...TWILIO.twilioConfig, whatsappFromNumber: "" } }), /Configure a WhatsApp sender/],
    ["the WhatsApp gate off", () => setSub({ ...CLOUD, whatsappEnabledByAgency: false }), "WhatsApp is disabled for this sub-account by your agency."],
    ["a per-contact link", () => mem.seed(PATH, { ...TEMPLATE, buttons: [{ type: "url", text: "Report", url: "{{prospecting.reportUrl}}" }] }), /filled in for each contact/],
    ["Twilio's narrower button rules", () => {
      setSub(TWILIO);
      mem.seed(PATH, { ...TEMPLATE, buttons: [{ type: "quick_reply", text: "Yes" }, { type: "url", text: "Site", url: "https://x.example" }] });
    }, /all be quick replies or all be links/],
    ["another sub-account's template", () => {
      mem.clear();
      setSub(CLOUD);
      mem.seed("subAccounts/sa1/apiKeys/key1", { subAccountId: "sa1", revokedAt: null });
      mem.seed("subAccounts/sa2/whatsappTemplates/t1", TEMPLATE);
    }, "Template not found"],
  ])("%s → refused, nothing submitted", async (_label, arrange, message) => {
    arrange();
    const before = mem.read(PATH);
    const r = await call({ templateId: "t1" });
    expect(r).toMatchObject({ ok: false, code: "invalid_request" });
    expect((r as { message: string }).message).toMatch(message);
    expect(createCloudTemplate).not.toHaveBeenCalled();
    expect(createContentTemplate).not.toHaveBeenCalled();
    expect(publishCallback).not.toHaveBeenCalled();
    expect(mem.read(PATH)).toEqual(before);
    expect(mem.list("auditEvents")).toEqual([]);
  });

  it.each([
    ["an id that is a path", { templateId: "t1/x/y" }],
    ["no id", {}],
    ["an unknown argument", { templateId: "t1", force: true }],
  ])("%s → invalid_args", async (_label, args) => {
    expect(await call(args)).toMatchObject({ ok: false, code: "invalid_args" });
    expect(createCloudTemplate).not.toHaveBeenCalled();
  });

  it("the provider refusing → failed with its reason, the error returned", async () => {
    createCloudTemplate.mockRejectedValue(new CloudTemplateError("Invalid parameter", 400));
    const r = await call({ templateId: "t1" });
    expect(r).toMatchObject({ ok: false, code: "invalid_request", message: "Submission failed: Invalid parameter (400)" });
    expect(mem.read(PATH)).toMatchObject({ status: "failed", rejectionReason: "Invalid parameter (400)" });
    expect(publishCallback).not.toHaveBeenCalled();
    // The doc was written (failed) though the call was refused: audited, naming the template.
    expect(mem.list("auditEvents")).toEqual([
      expect.objectContaining({ action: "agent.write", target: { type: "whatsappTemplate", id: "t1" } }),
    ]);
  });

  it("the first poll not queued → parked as failed, and the agent is told", async () => {
    publishCallback.mockResolvedValue(null);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await call({ templateId: "t1" });
    expect((r as { resultText: string }).resultText).toMatch(/could not be scheduled, so it is marked failed/);
    expect(mem.read(PATH)).toMatchObject({ status: "failed" });
    error.mockRestore();
  });

  it("an edit landing between the read and the write → refused, nothing sent to Meta, the edit stands", async () => {
    const doc = mem.db.doc.bind(mem.db);
    let raced = false;
    const spy = vi.spyOn(mem.db, "doc").mockImplementation((path: string) => {
      const ref = doc(path);
      if (path !== PATH || raced) return ref;
      raced = true;
      return {
        ...ref,
        get: async () => {
          const snap = await ref.get();
          await ref.update({ body: "Hi {{1}}, edited." });
          return snap;
        },
      };
    });
    const r = await call({ templateId: "t1" });
    spy.mockRestore();
    expect(raced).toBe(true);
    expect(r).toMatchObject({ ok: false, message: "The template changed while saving. Reload and try again." });
    expect(createCloudTemplate).not.toHaveBeenCalled();
    expect(mem.read(PATH)).toMatchObject({ body: "Hi {{1}}, edited.", status: "draft" });
  });
});
