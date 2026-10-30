import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, mem, setupDispatchTests } from "@/test/agent-dispatch-harness";

/**
 * create_whatsapp_template through the real dispatch, against the create
 * route it shares template-create.ts with: the same input stores the same
 * draft, an agent's draft is stamped, and anything a reader couldn't see is
 * refused before it can become a message body sent later.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-dispatch-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", () => ({ requireSubAccountAdmin: async () => ({ uid: "u_human" }) }));

const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { POST: createRoute } = await import("@/app/api/sub-accounts/[id]/whatsapp-templates/route");

setupDispatchTests();
const call = (args: unknown) => dispatchAgentTool(auth, "create_whatsapp_template", args);
const templates = () => mem.list("subAccounts/sa1/whatsappTemplates");

const DRAFT = {
  displayName: "Install day",
  category: "UTILITY",
  language: "en",
  body: "Hi {{1}}, your install is on {{2}}.",
  variables: [
    { position: 1, label: "First name", sampleValue: "Thandi", source: "merge_tag", mergeTag: "contact.firstName" },
    { position: 2, label: "Day", sampleValue: "Monday", source: "manual" },
  ],
  buttons: [{ type: "quick_reply", text: "That works" }, { type: "url", text: "Reschedule", url: "https://x.example/r" }],
};

beforeEach(() => {
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, whatsappEnabledByAgency: true });
});

describe("create_whatsapp_template", () => {
  it("stores the draft the create route stores for the same input, stamped as the agent's", async () => {
    const r = await call(DRAFT);
    expect(r).toMatchObject({ ok: true, ref: { kind: "whatsappTemplate" } });
    const agentId = (r as { ref: { id: string } }).ref.id;
    const res = await createRoute(
      new Request("https://app.test/api/sub-accounts/sa1/whatsapp-templates", { method: "POST", body: JSON.stringify(DRAFT) }),
      { params: Promise.resolve({ id: "sa1" }) },
    );
    expect(res.status).toBe(200);
    const humanId = ((await res.json()) as { template: { id: string } }).template.id;

    const agent = mem.read(`subAccounts/sa1/whatsappTemplates/${agentId}`)!;
    const human = mem.read(`subAccounts/sa1/whatsappTemplates/${humanId}`)!;
    const strip = ({ createdByUid: _u, createdAt: _c, updatedAt: _p, lastAgentEditAt: _a, lastAgentEditKey: _k, ...rest }: Record<string, unknown>) => rest;
    expect(strip(agent)).toEqual(strip(human));
    expect(agent).toMatchObject({
      subAccountId: "sa1", agencyId: "ag1", status: "draft", contentSid: null, name: "",
      createdByUid: "apikey:abcd1234", lastAgentEditKey: "abcd1234",
      // Quick replies first, as the shared sanitiser orders them.
      buttons: DRAFT.buttons,
    });
    expect(human).not.toHaveProperty("lastAgentEditKey");
  });

  it("accepts mergeTag: null on a manual variable (the stored shape)", async () => {
    const r = await call({ ...DRAFT, variables: [DRAFT.variables[0], { ...DRAFT.variables[1], mergeTag: null }] });
    expect(r).toMatchObject({ ok: true });
    const id = (r as { ref: { id: string } }).ref.id;
    expect(mem.read(`subAccounts/sa1/whatsappTemplates/${id}`)!.variables).toEqual([
      expect.objectContaining({ position: 1, mergeTag: "contact.firstName" }),
      expect.objectContaining({ position: 2, source: "manual", mergeTag: null }),
    ]);
  });

  it("defaults the language to en", async () => {
    const { language: _l, ...noLanguage } = DRAFT;
    const r = (await call(noLanguage)) as { ref: { id: string } };
    expect(mem.read(`subAccounts/sa1/whatsappTemplates/${r.ref.id}`)).toMatchObject({ language: "en" });
  });

  it.each([
    ["an unknown argument", { ...DRAFT, status: "approved" }, /unknown field "status"/],
    ["an unknown variable field", { ...DRAFT, variables: [{ ...DRAFT.variables[0], approved: true }, DRAFT.variables[1]] }, /variables\[0\] has an unknown field/],
    ["an unknown button field", { ...DRAFT, buttons: [{ type: "quick_reply", text: "Ok", payload: "x" }] }, /buttons\[0\] has an unknown field/],
    ["a bidi override in the body", { ...DRAFT, body: "Hi {{1}}, pay at ‮koob.example{{2}}" }, /body contains characters/],
    ["a zero-width space in the body", { ...DRAFT, body: "Hi {{1}}, b​ank on {{2}}" }, /body contains characters/],
    ["an invisible character in the name", { ...DRAFT, displayName: "Install⁠day" }, /displayName contains characters/],
    ["a line break in the name", { ...DRAFT, displayName: "Install\nday" }, /displayName contains characters/],
    ["a bidi mark in a label", { ...DRAFT, variables: [{ ...DRAFT.variables[0], label: "Name‏" }, DRAFT.variables[1]] }, /label contains characters/],
    ["a line break in a sample", { ...DRAFT, variables: [DRAFT.variables[0], { ...DRAFT.variables[1], sampleValue: "Mon\nday" }] }, /sampleValue contains characters/],
    ["an invisible character in a button", { ...DRAFT, buttons: [{ type: "quick_reply", text: "Y‍es" }] }, /text contains characters/],
    ["a mergeTag on a manual variable", { ...DRAFT, variables: [DRAFT.variables[0], { ...DRAFT.variables[1], mergeTag: "contact.email" }] }, /needs source merge_tag/],
    ["an AUTHENTICATION category", { ...DRAFT, category: "AUTHENTICATION" }, /UTILITY or MARKETING/],
    ["a body over 1024 characters", { ...DRAFT, body: `Hi {{1}} {{2}} ${"x".repeat(1020)}` }, /at most 1024/],
    ["a language that isn't a locale", { ...DRAFT, language: "english" }, /locale code/],
    ["a url on a quick reply", { ...DRAFT, buttons: [{ type: "quick_reply", text: "Ok", url: "https://x.example" }] }, /has no url/],
  ])("%s → invalid_args, nothing stored", async (_label, args, message) => {
    const r = await call(args);
    expect(r).toMatchObject({ ok: false, code: "invalid_args" });
    expect((r as { message: string }).message).toMatch(message);
    expect(templates()).toEqual([]);
  });

  it.each([
    ["placeholders out of sequence", { ...DRAFT, body: "Hi {{1}} on {{3}}" }, /numbered contiguously/],
    ["an unknown merge tag", { ...DRAFT, variables: [{ ...DRAFT.variables[0], mergeTag: "contact.secret" }, DRAFT.variables[1]] }, /unknown merge tag/],
    ["a Stop quick reply", { ...DRAFT, buttons: [{ type: "quick_reply", text: "STOP" }] }, /opt-out keyword/],
    ["a link that isn't https", { ...DRAFT, buttons: [{ type: "url", text: "Go", url: "http://x.example" }] }, /https:\/\//],
  ])("%s → refused by the shared validation, nothing stored", async (_label, args, message) => {
    const r = await call(args);
    expect(r).toMatchObject({ ok: false, code: "invalid_request" });
    expect((r as { message: string }).message).toMatch(message);
    expect(templates()).toEqual([]);
  });

  it("refuses while the agency's WhatsApp gate is off", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, whatsappEnabledByAgency: false });
    expect(await call(DRAFT)).toMatchObject({ ok: false, message: "WhatsApp is disabled for this sub-account by your agency." });
    expect(templates()).toEqual([]);
  });
});
