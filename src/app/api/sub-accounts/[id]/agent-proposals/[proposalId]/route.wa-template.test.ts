import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * send_whatsapp_template through the real dispatch and decide route and the
 * real template-send service, with only the WhatsApp template dispatch (the
 * provider call) and the review-ask log stubbed: propose sends nothing; the
 * approver reads exactly the text that is dispatched; approve sends once, to
 * the pinned number, as the approver; a changed template, recipient or
 * consent is never followed.
 */

const dispatch = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ ok: true, messageId: "wamid.T1", provider: "twilio" })));
const logAsk = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock("@/lib/comms/whatsapp/template-dispatch", () => ({ dispatchWhatsappTemplateSend: dispatch }));
vi.mock("@/lib/comms/whatsapp/cloud-credentials", async (orig) => ({ ...((await orig()) as object), whatsappCloudIsConfigured: async () => true }));
vi.mock("@/lib/reviews/review-ask", async (orig) => ({ ...((await orig()) as object), logInboxReviewAsk: logAsk }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

await setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const ANN = { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann Smith", phone: "+27821111111", territoryId: "global" };
const TPL = {
  subAccountId: "sa1", agencyId: "ag1", name: "install_day", displayName: "Install day", language: "en_US", status: "approved", contentSid: "HX1",
  body: "Hi {{1}}, your install is on {{2}}.\nReply YES to confirm.",
  variables: [
    { position: 1, label: "First name", sampleValue: "Ben", source: "merge_tag", mergeTag: "contact.firstName" },
    { position: 2, label: "Day", sampleValue: "Monday", source: "manual", mergeTag: null },
  ],
  buttons: [{ type: "quick_reply", text: "YES" }, { type: "url", text: "Reschedule", url: "https://x.io/r" }],
};
const RENDERED = "Hi Ann, your install is on Tuesday 10:00.\nReply YES to confirm.";
beforeEach(() => {
  dispatch.mockClear();
  logAsk.mockClear();
  mem.seed("subAccounts/sa1", {
    ...mem.read("subAccounts/sa1")!, whatsappEnabledByAgency: true,
    twilioConfig: { enabled: true, accountSid: "AC1", authTokenSet: true, whatsappFromNumber: "+27100000000" },
  });
  mem.seed("subAccounts/sa1/whatsappTemplates/wt1", TPL);
  mem.seed("contacts/c1", ANN);
  mem.seed("conversations/c1", { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", contactName: "Ann", territoryId: "global" });
});
const propose = (args: Record<string, unknown> = {}) =>
  dispatchAgentTool(auth, "send_whatsapp_template", { conversationId: "c1", templateId: "wt1", variables: { "2": "Tuesday 10:00" }, ...args });
async function proposeId(args: Record<string, unknown> = {}) {
  const r = await propose(args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const editTemplate = (patch: Record<string, unknown>) => mem.seed("subAccounts/sa1/whatsappTemplates/wt1", { ...TPL, ...patch });

describe("propose", () => {
  it("sends nothing; shows the template, language, when, the full rendered text and the buttons; pins number and render", async () => {
    const id = await proposeId();
    expect(row(id).preview).toEqual([
      { label: "To", value: "Ann Smith (…1111)" },
      { label: "Channel", value: "whatsapp" },
      { label: "Consent", value: "Not opted out of whatsapp." },
      { label: "Template", value: "Install day (install_day)" },
      { label: "Language", value: "en_US" },
      { label: "When", value: "Sends immediately when approved (quiet hours don't hold it). WhatsApp's 24-hour reply window doesn't apply to templates." },
      { label: "From", value: expect.any(String) }, // sender-number.test.ts
      { label: "Message", value: RENDERED, multiline: true },
      { label: "Buttons", value: 'quick reply "YES" · link "Reschedule" (https://x.io/r)' },
    ]);
    expect(row(id).pinned).toMatchObject({ contactId: "c1", channel: "whatsapp", to: "+27821111111", templateId: "wt1", rendered: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["a line break", { "2": "Tue\n10:00" }],
    ["a tab", { "2": "Tue\t10:00" }],
    ["five spaces in a row", { "2": "Tue     10:00" }],
    ["an invisible character", { "2": "Tue\u200b10:00" }],
    ["over 1024 characters", { "2": "x".repeat(1025) }],
    ["a key that isn't a position", { day: "Tue" }],
    ["a value that isn't text", { "2": 10 }],
    ["variables that aren't an object", true],
  ])("a variable with %s is refused", async (_label, variables) => {
    expect(await propose({ variables })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it.each([
    ["an unsafe merge-tag value", () => mem.seed("contacts/c1", { ...ANN, name: "Ann\u202e Smith" }), 'The "First name" value'],
    ["a filled-in text over 1024 characters", () => editTemplate({ body: `${"x".repeat(1020)} {{1}} {{2}}` }), "at most 1024"],
    ["an empty variable", () => mem.seed("contacts/c1", { ...ANN, name: "" }), 'Fill in "First name"'],
    ["a template not approved", () => editTemplate({ status: "paused" }), "isn't approved"],
    ["a missing template", () => mem.db.doc("subAccounts/sa1/whatsappTemplates/wt1").delete(), "Template not found"],
    ["the bridge rail", () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, whatsappProvider: "bridge" }), "bridge"],
    ["a merge-tag value with a run of no-break spaces", () => {
      editTemplate({ variables: [{ ...TPL.variables[0], mergeTag: "workspace.name" }, TPL.variables[1]] });
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, name: "Acme\u00a0\u00a0\u00a0\u00a0\u00a0Fibre" });
    }, "more than 4 spaces"],
    ["a stored value with a space that doesn't show as sent (U+1680)", () => {
      editTemplate({ variables: [{ ...TPL.variables[0], mergeTag: "workspace.name" }, TPL.variables[1]] });
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, name: "Acme\u1680Fibre" });
    }, "would not show exactly as sent"],
    ["a placeholder beyond the variables", () => editTemplate({ body: "Hi {{1}}, on {{2}} at {{3}}." }), "uses {{3}}, which has no variable"],
    ["a custom-field value with a space that doesn't show as sent", () => {
      editTemplate({ variables: [{ ...TPL.variables[0], mergeTag: "contact.customFields.street" }, TPL.variables[1]] });
      mem.seed("contacts/c1", { ...ANN, customFields: { street: "12\u1680Main" } });
    }, "would not show exactly as sent"],
    ["{{2}} in the body with only one variable", () => editTemplate({ body: "Hi {{1}}, on {{2}}.", variables: [TPL.variables[0]] }), "uses {{2}}, which has no variable"],
    ["a WhatsApp opt-out", () => mem.seed("contacts/c1", { ...ANN, whatsappOptedOut: true }), "opted out of WhatsApp"],
  ])("%s → refused, no proposal", async (_label, arrange, message) => {
    await arrange();
    const r = await propose();
    expect(r).toMatchObject({ ok: false });
    expect((r as { message?: string }).message).toContain(message);
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it.each([
    ["a variable's stored value", () => mem.seed("contacts/c1", { ...ANN, customFields: { street: "12\u1680Main" } }), 'The "First name" value has'],
    ["the template's own text", () => editTemplate({ body: "Hi {{1}},\u1680your install is on {{2}}." }), "The template's text has"],
  ])("spacing that wouldn't show as sent in %s → the refusal names where", async (_label, arrange, where) => {
    editTemplate({ variables: [{ ...TPL.variables[0], mergeTag: "contact.customFields.street" }, TPL.variables[1]] });
    mem.seed("contacts/c1", { ...ANN, customFields: { street: "12 Main" } });
    arrange();
    expect(await propose()).toMatchObject({ ok: false, message: `${where} spacing or characters that would not show exactly as sent.` });
  });

  it("variables stored out of position order → the refusal still names the right one", async () => {
    const street = { position: 2, label: "Street", sampleValue: "1 Main", source: "merge_tag", mergeTag: "contact.customFields.street" };
    editTemplate({ variables: [street, TPL.variables[0]] });
    mem.seed("contacts/c1", { ...ANN, customFields: { street: "12\u1680Main" } });
    expect(await propose({ variables: {} })).toMatchObject({ ok: false, message: 'The "Street" value has spacing or characters that would not show exactly as sent.' });
  });

  it("another sub-account's conversation, or a templateId that is a path → refused, nothing written", async () => {
    mem.seed("contacts/c2", { ...ANN, subAccountId: "sa2" });
    mem.seed("conversations/c2", { subAccountId: "sa2", agencyId: "ag1", contactId: "c2" });
    const before = JSON.stringify(mem.all());
    expect(await propose({ conversationId: "c2" })).toMatchObject({ ok: false, httpStatus: 400 });
    expect(await propose({ templateId: "wt1/sub/y" })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(JSON.stringify(mem.all())).toBe(before);
  });
});

describe("approve", () => {
  const sentArgs = () => dispatch.mock.calls[0]![0] as { to: string; values: string[]; template: { body: string }; origin: string };

  it("sends exactly once, to the pinned number, as the approver; what was dispatched is what the approver read", async () => {
    const id = await proposeId();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sentArgs()).toMatchObject({ to: "+27821111111", values: ["Ann", "Tuesday 10:00"], origin: "manual" });
    const { renderPreview } = await import("@/lib/server/whatsapp-template-send");
    const message = (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === "Message")!.value;
    expect(renderPreview(sentArgs().template.body, sentArgs().values)).toBe(message);
    expect(mem.read("contacts/c1/whatsappMessages/wamid.T1")).toMatchObject({ body: RENDERED, sentByUid: "u_admin", to: "+27821111111" });
    expect(row(id).status).toBe("executed");
  });

  it("two concurrent approves → one send", async () => {
    const id = await proposeId();
    expect((await Promise.all([decide(id, "approve"), decide(id, "approve")])).map((r) => r.status).sort()).toEqual([200, 409]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["its body", { body: "Hi {{1}}, your install moved to {{2}}." }],
    ["its buttons", { buttons: [{ type: "quick_reply", text: "NO" }] }],
    ["its language", { language: "af" }],
  ])("the template's %s changed since the proposal → preview_changed, 0 sends", async (_label, patch) => {
    const id = await proposeId();
    editTemplate(patch);
    const res = await decide(id, "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "preview_changed" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("the provider's template id (sid) changed since the proposal → preview_changed, 0 sends", async () => {
    const id = await proposeId();
    editTemplate({ contentSid: "HX2" });
    const res = await decide(id, "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "preview_changed" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("the template was unapproved since the proposal → refused at approve, 0 sends", async () => {
    const id = await proposeId();
    editTemplate({ status: "paused" });
    expect((await decide(id, "approve")).status).toBe(409);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("the template changed between the approve-time re-check and the send → failed, 0 sends", async () => {
    const id = await proposeId();
    beforeNextTransaction(async () => editTemplate({ body: "Hi {{1}}, it moved to {{2}}." }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: "The template or its values changed since this was reviewed; nothing was sent." });
    expect(dispatch).not.toHaveBeenCalled();
  });

  const TEMPLATE_CHANGED = "The template or its values changed since this was reviewed; nothing was sent.";
  it.each([
    ["the provider's template id (sid)", () => editTemplate({ contentSid: "HX2" }), TEMPLATE_CHANGED],
    // A rail switch also moves the sending number, which is re-checked first.
    ["the rail", () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, whatsappProvider: "cloud" }), "The number it would be sent from changed since this was reviewed; nothing was sent."],
    ["a merge-tag value (the contact's name)", () => mem.seed("contacts/c1", { ...ANN, name: "Bob Smith" }), TEMPLATE_CHANGED],
  ])("%s changed between the approve-time re-check and the send → failed, 0 sends", async (_label, change, error) => {
    // The same id on both rails, so a rail switch changes nothing but the rail.
    editTemplate({ registrations: { cloud: { externalId: "HX1", status: "approved", rejectionReason: null } } });
    const id = await proposeId();
    beforeNextTransaction(async () => change());
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("opted out of WhatsApp since the proposal: the approver sees it, and approving anyway fails with 0 sends", async () => {
    const id = await proposeId();
    mem.seed("contacts/c1", { ...ANN, whatsappOptedOut: true });
    expect((await decide(id, "approve")).status).toBe(409);
    expect(row(id).preview).toContainEqual({ label: "Consent", value: "This contact has opted out of WhatsApp. It will not be sent." });
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: "This contact has opted out of WhatsApp." });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("settle", () => {
  it.each([
    ["the dispatch throws (the service answers 502)", () => dispatch.mockRejectedValueOnce(new Error("socket hang up"))],
    ["the provider was contacted and refused", () => dispatch.mockResolvedValueOnce({ ok: false, attempted: true, error: "Meta said no", provider: "cloud" })],
    ["a write after the send throws", () => logAsk.mockRejectedValueOnce(new Error("firestore down"))],
  ])("%s → unsettled, never failed", async (_label, arrange) => {
    arrange();
    const id = await proposeId();
    expect((await decide(id, "approve")).status).toBe(202);
    expect(row(id).status).toBe("unsettled");
  });

  it("refused before any provider call → failed", async () => {
    dispatch.mockResolvedValueOnce({ ok: false, error: "Template isn't approved for sending.", provider: "twilio" });
    const id = await proposeId();
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: "Template isn't approved for sending." });
  });
});
