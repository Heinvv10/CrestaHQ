import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { seedPr13, TEMPLATE } from "@/test/pr13-fixtures";

/**
 * create_broadcast (PR13) through the real dispatch and decide route and the
 * send route's own checks: an outbound proposal with the exact template, the
 * audience and how many it matches; approve re-resolves the audience, refuses
 * growth, and starts a broadcast that carries what was approved.
 */

const publishCallback = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ messageId: "q" })));
vi.mock("@/lib/automations/qstash", async (orig) => ({ ...((await orig()) as object), qstashIsConfigured: () => true, publishCallback }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { templateFingerprint } = await import("@/lib/broadcasts/approved");

const ALL = { templateId: "tpl_email", audienceFilter: { kind: "all" } };
const contact = (id: string, patch: Record<string, unknown> = {}) =>
  mem.seed(`contacts/${id}`, { subAccountId: "sa1", agencyId: "ag1", name: id, email: `${id}@x.io`, tags: [], ...patch });
const call = (args: Record<string, unknown>) => dispatchAgentTool(auth, "create_broadcast", args);
async function proposeId(args: Record<string, unknown> = ALL): Promise<string> {
  const r = await call(args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;

beforeEach(() => {
  publishCallback.mockClear();
  seedPr13(mem);
  contact("c1", { tags: ["vip"] });
  contact("c2");
});

describe("create_broadcast", () => {
  it("an outbound proposal with the exact template and the matched count; approve starts a broadcast carrying them", async () => {
    const id = await proposeId();
    expect(row(id).approval).toBe("outbound");
    expect(rowOf(id, "To")).toBe("every contact: 2 contact(s) now, less those opted out or without an email");
    expect(rowOf(id, "Subject")).toBe("Winter special");
    expect(row(id).preview).toContainEqual({ label: "Message", value: TEMPLATE.body, multiline: true });
    expect(row(id).pinned).toMatchObject({ templateId: "tpl_email", audienceCount: 2, templateFingerprint: templateFingerprint(TEMPLATE as never) });
    expect(mem.list("broadcasts")).toEqual([]);
    expect((await decide(id, "approve")).status).toBe(200);
    const [b] = mem.list("broadcasts");
    expect(b).toMatchObject({ status: "queued", templateId: "tpl_email", audienceFilter: { kind: "all" }, approved: { audienceCap: 2, templateFingerprint: templateFingerprint(TEMPLATE as never) } });
    expect(publishCallback).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/api/broadcasts/email/fanout" }));
  });

  it("a tag audience counts only its contacts", async () => {
    const id = await proposeId({ ...ALL, audienceFilter: { kind: "tag", tag: "vip" } });
    expect(rowOf(id, "To")).toBe('contacts tagged "vip": 1 contact(s) now, less those opted out or without an email');
  });

  it("the audience grew after the approver's preview check -> failed, nothing started", async () => {
    const id = await proposeId();
    beforeNextTransaction(async () => contact("c3"));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("The audience grew to 3 contacts since 2 were approved; nothing was sent. Propose it again.");
    expect(mem.list("broadcasts")).toEqual([]);
  });

  it("the template edited after the approver's preview check -> failed, nothing started", async () => {
    const id = await proposeId();
    beforeNextTransaction(async () => mem.seed("message_templates/tpl_email", { ...TEMPLATE, body: `${TEMPLATE.body}\nNew line` }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.list("broadcasts")).toEqual([]);
  });

  it.each([
    ["broadcasts off for the sub-account", () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, broadcastsEnabledByAgency: false }), expect.stringContaining("Broadcasts are disabled")],
    ["a template without an unsubscribe link", () => mem.seed("message_templates/tpl_email", { ...TEMPLATE, body: "Hi" }), "Email body must include {{unsubscribeLink}} somewhere."],
    ["a template with a hidden character", () => mem.seed("message_templates/tpl_email", { ...TEMPLATE, body: `${TEMPLATE.body}\u200b` }), "The template has characters or spacing that can't be shown exactly as sent."],
    ["an empty audience", () => (contact("c1", { subAccountId: "sa2" }), contact("c2", { subAccountId: "sa2" })), "Audience is empty \u2014 no contacts match this filter."],
  ])("%s -> refused at propose", async (_label, arrange, message) => {
    arrange();
    expect(await call(ALL)).toMatchObject({ ok: false, message });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("a malformed audience / a path template id -> invalid args", async () => {
    expect(await call({ ...ALL, audienceFilter: { kind: "tag" } })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(await call({ ...ALL, templateId: "t/x/y" })).toMatchObject({ ok: false, code: "invalid_args" });
  });
});
