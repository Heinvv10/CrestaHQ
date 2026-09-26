import { beforeEach, describe, expect, it, vi } from "vitest";
import { mem } from "@/test/agent-proposals-harness";
import { seedPr13 } from "@/test/pr13-fixtures";

/** POST /social/posts, now using lib/social/post-rules.ts: drafts and scheduling as before. */

const publishSocialPost = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ messageId: "qs1" })));
vi.mock("@/lib/automations/qstash", async (orig) => ({ ...((await orig()) as object), qstashIsConfigured: () => true, publishSocialPost }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());

const { POST } = await import("./route");
const post = (body: Record<string, unknown>) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "sa1" }) });

beforeEach(() => {
  mem.clear();
  publishSocialPost.mockClear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  seedPr13(mem);
});

describe("POST /social/posts", () => {
  it("a draft is written; a scheduled post is queued and written scheduled", async () => {
    const draft = (await (await post({ caption: "Hi", targets: ["facebook"] })).json()) as { id: string };
    expect(mem.read(`socialPosts/${draft.id}`)).toMatchObject({ status: "draft", caption: "Hi" });
    const res = await post({ caption: "Hi", targets: ["facebook"], status: "scheduled", scheduledAt: "2030-01-10T08:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(publishSocialPost).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ caption: "Hi", imageUrl: "http://x.io/a.png" }, 400],
    [{ caption: "Hi", targets: ["instagram"], status: "scheduled", scheduledAt: "2030-01-10T08:00:00.000Z" }, 400],
    [{ caption: "Hi", targets: [], status: "scheduled", scheduledAt: "2030-01-10T08:00:00.000Z" }, 400],
  ])("%j -> %s, nothing written", async (body, status) => {
    expect((await post(body)).status).toBe(status);
    expect(mem.list("socialPosts").filter((p) => p.id !== "sp1")).toEqual([]);
  });
});
