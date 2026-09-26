import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * The PR10 custom-field and folder capabilities through the real dispatch
 * and decide route: writes go through the settings routes' own writers,
 * keys are generated (never the agent's), labels / options / names must be
 * visible text, and a delete shows what reads the field.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const FIELDS = "subAccounts/sa1/customFields";
const FOLDERS = "subAccounts/sa1/customFieldFolders";
const FIELD = { subAccountId: "sa1", agencyId: "ag1", entity: "contact", key: "install_date", label: "Install date", type: "text", options: [], required: false, order: 0 };
const call = (name: string, args: Record<string, unknown>) => dispatchAgentTool(auth, name, args);
async function proposeId(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await call(name, args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}

beforeEach(() => {
  mem.seed(`${FIELDS}/cf1`, FIELD);
  mem.seed(`${FOLDERS}/fo1`, { subAccountId: "sa1", agencyId: "ag1", name: "Install", entity: "contact", order: 0 });
  mem.seed(`${FOLDERS}/fo2`, { subAccountId: "sa1", agencyId: "ag1", name: "Deal stuff", entity: "deal", order: 0 });
});

describe("custom fields", () => {
  it("create_custom_field generates the key from the label and stamps it", async () => {
    const r = await call("create_custom_field", { entity: "contact", label: "Install date", type: "dropdown", options: ["AM", "PM"] });
    expect(r).toMatchObject({ ok: true, resultText: expect.stringContaining("key: install_date_2") });
    const id = (r as { ref: { id: string } }).ref.id;
    expect(mem.read(`${FIELDS}/${id}`)).toMatchObject({ key: "install_date_2", options: ["AM", "PM"], order: 1, lastAgentEditKey: "abcd1234" });
  });

  it.each([
    ["an invisible character in the label", { entity: "contact", label: "Install\u200bdate", type: "text" }, "the label contains characters"],
    ["an invisible character in an option", { entity: "contact", label: "Slot", type: "dropdown", options: ["AM", "P\u200bM"] }, "an option contains characters"],
    ["an unknown type", { entity: "contact", label: "Slot", type: "rocket" }, "Field type must be one of"],
    ["no options for a dropdown", { entity: "contact", label: "Slot", type: "dropdown" }, "need an options list"],
  ])("create_custom_field with %s → refused", async (_label, args, message) => {
    expect(await call("create_custom_field", args)).toMatchObject({ ok: false, code: "invalid_args", message: expect.stringContaining(message) });
    expect(mem.list(FIELDS)).toHaveLength(1);
  });

  it("update_custom_field edits label and folder, stamped; a folder of the other entity is refused", async () => {
    expect(await call("update_custom_field", { fieldId: "cf1", label: "Install day", folderId: "fo1" })).toMatchObject({ ok: true });
    expect(mem.read(`${FIELDS}/cf1`)).toMatchObject({ label: "Install day", folderId: "fo1", key: "install_date", lastAgentEditKey: "abcd1234" });
    expect(await call("update_custom_field", { fieldId: "cf1", folderId: "fo2" })).toMatchObject({ ok: false, message: "Folder not found" });
    expect(await call("update_custom_field", { fieldId: "cf1", folderId: "fo1/x/y" })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(await call("update_custom_field", { fieldId: "cf1", label: "Day\u200b" })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(await call("update_custom_field", { fieldId: "cf1" })).toMatchObject({
      ok: false, code: "invalid_args", message: "give at least one of label, options, required, order, folderId",
    });
  });

  it("delete_custom_field → a proposal counting what reads the field; approve deletes it", async () => {
    mem.seed("workflows/w1", { subAccountId: "sa1", trigger: { type: "contact.created", filters: { all: [{ field: "customFields.install_date", op: "is_set" }] } }, nodes: {} });
    mem.seed("workflows/w2", { subAccountId: "sa1", nodes: { n1: { config: { body: "{{contact.customFields.install_date_2}}" } } } });
    mem.seed("workflows/w3", { subAccountId: "sa2", nodes: { n1: { config: { body: "{{contact.customFields.install_date}}" } } } });
    mem.seed("subAccounts/sa1/whatsappTemplates/t1", { variables: [{ position: 1, source: "merge_tag", mergeTag: "contact.customFields.install_date" }] });
    mem.seed("snippets/s1", { subAccountId: "sa1", body: "Your install is {{contact.customFields.install_date}}" });
    mem.seed("message_templates/m1", { subAccountId: "sa1", body: "Install: {{contact.customFields.install_date}}" });
    mem.seed("message_templates/m2", { subAccountId: "sa2", body: "Install: {{contact.customFields.install_date}}" });
    mem.seed("subAccounts/sa1/smartLists/l1", { subAccountId: "sa1", filters: { all: [{ field: "customFields.install_date", op: "is_set" }] } });
    mem.seed("subAccounts/sa2/smartLists/l2", { subAccountId: "sa2", filters: { all: [{ field: "customFields.install_date", op: "is_set" }] } });
    const id = await proposeId("delete_custom_field", { fieldId: "cf1" });
    expect(row(id).preview).toEqual(expect.arrayContaining([
      { label: "Delete custom field", value: "Install date" },
      { label: "Key", value: "contact · customFields.install_date · text" },
      {
        label: "Used by",
        value:
          "1 workflow(s), 1 email/SMS template(s) (broadcasts send these), 1 WhatsApp template(s), 1 snippet(s), 1 smart list(s). " +
          "Not checked: the agency's template library and snapshots.",
      },
      { label: "Stored values", value: "Stay on each contact. Everything above keeps reading and writing them, but the app can no longer show or edit them." },
      { label: "Same key later", value: "A field created later with the same label gets the same key and shows these old values." },
    ]));
    expect(mem.read(`${FIELDS}/cf1`)).toBeDefined();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read(`${FIELDS}/cf1`)).toBeUndefined();
  });

  it("the workspace's own settings naming the field are counted too", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, twilioConfig: { missedCallTextBack: { message: "Sorry {{contact.customFields.install_date}}" } } });
    const id = await proposeId("delete_custom_field", { fieldId: "cf1" });
    expect((row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === "Used by")!.value).toContain(
      "0 smart list(s), and the workspace settings (e.g. the missed-call text-back)."
    );
  });

  it("another sub-account's field isn't found; list shows only this one's, filtered by entity", async () => {
    mem.seed("subAccounts/sa2/customFields/cf9", { ...FIELD, subAccountId: "sa2", label: "Theirs" });
    expect(await call("update_custom_field", { fieldId: "cf9", label: "X" })).toMatchObject({ ok: false, message: "That custom field isn't in this workspace." });
    expect(await call("delete_custom_field", { fieldId: "cf9" })).toMatchObject({ ok: false });
    const list = await call("list_custom_fields", { entity: "contact" });
    expect(list).toMatchObject({ resultText: expect.stringContaining("Install date — id: cf1, key: install_date, contact, text") });
    expect(JSON.stringify(list)).not.toContain("Theirs");
  });
});

describe("folders", () => {
  it("create / rename / reorder go through the settings writers", async () => {
    const r = await call("create_custom_field_folder", { name: "Billing", entity: "contact" });
    const id = (r as { ref: { id: string } }).ref.id;
    expect(mem.read(`${FOLDERS}/${id}`)).toMatchObject({ name: "Billing", order: 1, lastAgentEditKey: "abcd1234" });
    expect(await call("update_custom_field_folder", { folderId: "fo1", name: "Installs" })).toMatchObject({ ok: true });
    expect(mem.read(`${FOLDERS}/fo1`)).toMatchObject({ name: "Installs" });
    expect(await call("reorder_custom_field_folders", { entity: "contact", ids: [id, "fo1"] })).toMatchObject({ ok: true });
    expect([mem.read(`${FOLDERS}/${id}`)!.order, mem.read(`${FOLDERS}/fo1`)!.order]).toEqual([0, 1]);
    expect(await call("reorder_custom_field_folders", { entity: "contact", ids: ["fo1"] })).toMatchObject({
      ok: false, message: "ids must list every folder of this entity exactly once.",
    });
  });

  it.each([
    ["create_custom_field_folder", { name: "Bil\u200bling", entity: "contact" }],
    ["update_custom_field_folder", { folderId: "fo1", name: "Ins\u200btall" }],
    ["reorder_custom_field_folders", { entity: "contact", ids: ["fo1", "fo1"] }],
    ["reorder_custom_field_folders", { entity: "contact", ids: ["fo1/x/y"] }],
  ])("%s with bad input → refused", async (name, args) => {
    expect(await call(name, args)).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("delete_custom_field_folder → a proposal saying how many fields move to General; approve moves them", async () => {
    mem.seed(`${FIELDS}/cf1`, { ...FIELD, folderId: "fo1" });
    const id = await proposeId("delete_custom_field_folder", { folderId: "fo1" });
    expect(row(id).preview).toContainEqual({ label: "Fields moved to General", value: "1" });
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read(`${FOLDERS}/fo1`)).toBeUndefined();
    expect(mem.read(`${FIELDS}/cf1`)!.folderId).toBeNull();
  });
});
