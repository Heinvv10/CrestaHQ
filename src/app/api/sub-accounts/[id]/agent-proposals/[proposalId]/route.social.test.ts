import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { POST, seedPr13 } from "@/test/pr13-fixtures";

/**
 * The PR13 social capabilities through the real dispatch and decide route:
 * an agent's post is only ever a draft; publishing it is a public_change
 * proposal showing exactly what goes public and the accounts it goes to,
 * pinned and re-checked when approved; a delete shows the whole post.
 */

const publishSocialPost = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ messageId: "qs1" }) as { messageId: string } | null));
vi.mock("@/lib/automations/qstash", async (orig) => ({ ...((await orig()) as object), qstashIsConfigured: () => true, publishSocialPost }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const WHEN = "2030-01-10T08:00:00.000Z";
const call = (name: string, args: Record<string, unknown>) => dispatchAgentTool(auth, name, args);
async function proposeId(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await call(name, args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;
const meta = (patch: Record<string, unknown>) =>
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, metaConfig: { ...(mem.read("subAccounts/sa1")!.metaConfig as object), ...patch } });

beforeEach(() => {
  publishSocialPost.mockClear();
  seedPr13(mem);
});

describe("create_social_post", () => {
  it("status:\"scheduled\" lands as a draft, stamped; nothing is queued", async () => {
    const r = await call("create_social_post", { caption: "Winter special\nHalf price", targets: ["facebook"], status: "scheduled" });
    const id = (r as { ref: { id: string } }).ref.id;
    expect(mem.read(`socialPosts/${id}`)).toMatchObject({ status: "draft", caption: "Winter special\nHalf price", targets: ["facebook"], lastAgentEditKey: "abcd1234" });
    expect(publishSocialPost).not.toHaveBeenCalled();
  });

  it.each([
    ["an invisible character", { caption: "Hi\u200b" }],
    ["an http image", { caption: "Hi", imageUrl: "http://x.io/a.png" }],
  ])("%s -> invalid args", async (_label, args) => {
    expect(await call("create_social_post", args)).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("the planner locked by the agency -> refused", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, socialPlannerEnabledByAgency: false });
    expect(await call("create_social_post", { caption: "Hi" })).toMatchObject({ ok: false, message: "Social Planner is locked by your agency." });
  });
});

describe("schedule_social_post", () => {
  it("a public_change proposal with the exact caption and the Page; approve schedules it for those accounts", async () => {
    const id = await proposeId("schedule_social_post", { postId: "sp1", scheduledAt: WHEN });
    expect(row(id).approval).toBe("public_change");
    expect(row(id).preview).toContainEqual({ label: "Caption", value: POST.caption, multiline: true });
    expect(rowOf(id, "Facebook Page")).toBe("Acme Fibre (page1)");
    expect(row(id).pinned).toMatchObject({ postId: "sp1", pageId: "page1", igUserId: null, scheduledAt: WHEN, caption: POST.caption });
    expect(mem.read("socialPosts/sp1")!.status).toBe("draft");
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("socialPosts/sp1")).toMatchObject({ status: "scheduled", approvedAccounts: { pageId: "page1", igUserId: null }, qstashMessageId: "qs1" });
    expect(publishSocialPost).toHaveBeenCalledTimes(1);
  });

  it("the Page reconnected after the approver's preview check -> failed, still a draft, nothing queued", async () => {
    const id = await proposeId("schedule_social_post", { postId: "sp1", scheduledAt: WHEN });
    beforeNextTransaction(async () => meta({ pageId: "page2" }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.read("socialPosts/sp1")!.status).toBe("draft");
    expect(publishSocialPost).not.toHaveBeenCalled();
  });

  it("the queue refuses the job -> back to a draft", async () => {
    publishSocialPost.mockResolvedValueOnce(null);
    const id = await proposeId("schedule_social_post", { postId: "sp1", scheduledAt: WHEN });
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.read("socialPosts/sp1")).toMatchObject({ status: "draft", approvedAccounts: null });
  });

  it.each([
    ["a post that isn't a draft", () => mem.seed("socialPosts/sp1", { ...POST, status: "published" }), "Only a draft can be scheduled (this post is published)."],
    ["Instagram without an image", () => mem.seed("socialPosts/sp1", { ...POST, targets: ["instagram"] }), "Instagram posts require an image URL."],
    ["no posting permission", () => meta({ capabilities: { publish: false } }), expect.stringContaining("Connect a Facebook Page with posting permission first")],
    ["a caption with a hidden character", () => mem.seed("socialPosts/sp1", { ...POST, caption: "Hi\u200b" }), "The caption has characters or spacing that can't be shown exactly as posted."],
  ])("%s -> refused at propose", async (_label, arrange, message) => {
    arrange();
    expect(await call("schedule_social_post", { postId: "sp1", scheduledAt: WHEN })).toMatchObject({ ok: false, message });
  });

  it("a time already past when approved -> failed", async () => {
    const id = await proposeId("schedule_social_post", { postId: "sp1", scheduledAt: "2020-01-01T00:00:00.000Z" });
    expect((await decide(id, "approve")).status).toBe(422);
    expect(publishSocialPost).not.toHaveBeenCalled();
  });
});

describe("delete_social_post", () => {
  it("a hard_delete proposal with the whole post; a published one says the live post stays", async () => {
    mem.seed("socialPosts/sp1", { ...POST, status: "published" });
    const id = await proposeId("delete_social_post", { postId: "sp1" });
    expect(row(id).approval).toBe("hard_delete");
    expect(rowOf(id, "Then")).toBe("Only the planner's copy is removed; anything already posted stays on the platform.");
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("socialPosts/sp1")).toBeUndefined();
  });

  it("being published inside the delete's transaction -> failed, kept", async () => {
    const id = await proposeId("delete_social_post", { postId: "sp1" });
    beforeNextTransaction(async () => beforeNextTransaction(async () => mem.seed("socialPosts/sp1", { ...POST, status: "publishing" })));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.read("socialPosts/sp1")).toBeDefined();
  });
});
