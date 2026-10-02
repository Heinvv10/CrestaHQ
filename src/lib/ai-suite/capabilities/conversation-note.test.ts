import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, caller, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * add_conversation_note through the real dispatchAgentTool (and, for the
 * human comparison, the real mention-tasks route) over an in-memory
 * Firestore: the note has a human note's shape, mentions create the same
 * tasks, and every guard refuses with the store untouched.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { getCapability } = await import("@/lib/ai-suite/capabilities");
const { POST: humanMentionTasks } = await import(
  "@/app/api/sub-accounts/[id]/contacts/[contactId]/notes/[noteId]/mention-tasks/route"
);

const notes = (c = "c1") => mem.list(`contacts/${c}/notes`);
const tasks = () => mem.list("tasks");
const member = (uid: string, displayName: string, email: string, status = "active") =>
  mem.seed(`subAccounts/sa1/subAccountMembers/${uid}`, { status, displayName, email, role: "collaborator" });

beforeEach(() => {
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann", territoryId: "global" });
  mem.seed("contacts/c2", { subAccountId: "sa2", agencyId: "ag1", name: "Bob" });
  member("mike", "Mike Dlamini", "mike@x.io");
  member("gone", "Gone Person", "gone@x.io", "removed");
  mem.seed("subAccounts/sa2/subAccountMembers/other", { status: "active", displayName: "Other", email: "other@y.io", role: "collaborator" });
});

describe("add_conversation_note", () => {
  it("writes a note shaped like the composer's, stamped as the agent's, with line breaks kept", async () => {
    const r = await dispatchAgentTool(auth, "add_conversation_note", { contactId: "c1", body: "Called back.\nNo answer." });
    expect(r).toMatchObject({ ok: true });
    const [n] = notes();
    expect(n).toMatchObject({ content: "Called back.\nNo answer.", createdBy: "apikey:abcd1234", source: "conversation", lastAgentEditKey: "abcd1234" });
    expect(n.createdAt).toBeDefined();
    expect(n).not.toHaveProperty("mentionedUids");
    expect(tasks()).toHaveLength(0);
  });

  it("a mention stores mentionedUids, appends the missing @Name and creates the same task the human route does", async () => {
    const r = await dispatchAgentTool(auth, "add_conversation_note", { contactId: "c1", body: "Please follow up.", mentions: ["Mike@X.io"] });
    expect(r).toMatchObject({ ok: true });
    const [n] = notes();
    expect(n).toMatchObject({ content: "Please follow up. @Mike Dlamini", mentionedUids: ["mike"] });
    expect(tasks()).toHaveLength(1);

    // The human path: a composer-shaped note, then the real route.
    mem.seed("contacts/c1/notes/human", { content: n.content, createdBy: caller.uid, source: "conversation", mentionedUids: ["mike"] });
    const res = await humanMentionTasks(new Request("https://crm.test", { method: "POST" }), {
      params: Promise.resolve({ id: "sa1", contactId: "c1", noteId: "human" }),
    });
    expect(res.status).toBe(201);
    const [agentTask, humanTask] = tasks();
    const same = ["notes", "assignedToUid", "contactId", "subAccountId", "agencyId", "territoryId", "completed"] as const;
    for (const k of same) expect(agentTask[k], k).toEqual(humanTask[k]);
    expect(agentTask.title).toContain("Mentioned by API agent abcd1234 in");
  });

  it("does not append @Name when the body already has it", async () => {
    await dispatchAgentTool(auth, "add_conversation_note", { contactId: "c1", body: "@Mike Dlamini look", mentions: ["mike@x.io"] });
    expect(notes()[0].content).toBe("@Mike Dlamini look");
  });

  it("the note is claimed (mentionTasksAt) so a later human route call cannot duplicate the tasks", async () => {
    await dispatchAgentTool(auth, "add_conversation_note", { contactId: "c1", body: "x", mentions: ["mike@x.io"] });
    expect(notes()[0].mentionTasksAt).toBeDefined();
  });

  it.each([
    ["a removed member", { mentions: ["gone@x.io"] }],
    ["another sub-account's member", { mentions: ["other@y.io"] }],
    ["an unknown email", { mentions: ["nobody@x.io"] }],
  ])("%s → refused, nothing written", async (_n, extra) => {
    const before = JSON.stringify(mem.all());
    expect(await dispatchAgentTool(auth, "add_conversation_note", { contactId: "c1", body: "hi", ...extra })).toMatchObject({ ok: false, httpStatus: 400 });
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it("another sub-account's contact → refused, nothing written", async () => {
    const before = JSON.stringify(mem.all());
    expect(await dispatchAgentTool(auth, "add_conversation_note", { contactId: "c2", body: "hi" })).toMatchObject({ ok: false, httpStatus: 400 });
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it.each([
    ["a bidi override", { body: "ok ‮evil" }],
    ["a zero-width space", { body: "a​b" }],
    ["a NUL", { body: "a\u0000b" }],
    ["an empty body", { body: "  " }],
    ["a body over the cap", { body: "x".repeat(4001) }],
    ["an unknown key", { body: "hi", sendTo: "customer" }],
    ["a malformed mention", { body: "hi", mentions: ["not-an-email"] }],
    ["too many mentions", { body: "hi", mentions: Array.from({ length: 11 }, (_, i) => `m${i}@x.io`) }],
    ["a bad contact id", { contactId: "../x", body: "hi" }],
  ])("%s → refused, nothing written", async (_n, extra) => {
    const before = JSON.stringify(mem.all());
    expect(await dispatchAgentTool(auth, "add_conversation_note", { contactId: "c1", ...extra })).toMatchObject({ ok: false, httpStatus: 400 });
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  // validate() alone: execute re-checks the body after appending @Names, so
  // the dispatch-level cases above cannot tell which layer refused.
  it.each([
    ["a bidi override", { body: "ok \u202Eevil" }],
    ["a body over the cap", { body: "x".repeat(4001) }],
    ["a malformed mention", { body: "hi", mentions: ["not-an-email"] }],
    ["too many mentions", { body: "hi", mentions: Array.from({ length: 11 }, (_, i) => `m${i}@x.io`) }],
  ])("validate refuses %s", (_n, extra) => {
    expect(getCapability("add_conversation_note")!.validate({ contactId: "c1", ...extra })).toMatchObject({ ok: false });
  });

  it("validate keeps line breaks and lower-cases and de-duplicates mention emails", () => {
    expect(
      getCapability("add_conversation_note")!.validate({ contactId: "c1", body: "a\r\nb", mentions: ["A@x.io", "a@x.io"] })
    ).toEqual({ ok: true, args: { contactId: "c1", body: "a\nb", mentions: ["a@x.io"] } });
  });
});
