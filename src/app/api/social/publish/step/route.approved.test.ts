import { beforeEach, describe, expect, it, vi } from "vitest";

/** A post a person approved for an API agent publishes only to the accounts they reviewed. */

const meta = vi.hoisted(() => ({
  publishToFacebookPage: vi.fn(async (..._a: unknown[]) => ({ id: "fb1" })),
  publishToInstagram: vi.fn(async (..._a: unknown[]) => ({ id: "ig1" })),
}));
vi.mock("@/lib/automations/qstash", () => ({ qstashIsConfigured: () => true, verifyQStashSignature: async () => true }));
vi.mock("@/lib/comms/meta", () => meta);
vi.mock("@/lib/server/sub-account-secrets", () => ({ readSubAccountSecret: async () => "page-token" }));
const mem = await vi.hoisted(async () => (await import("@/test/memory-firestore")).createMemoryFirestore());
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { POST } = await import("./route");
const run = () =>
  POST(new Request("https://app.test/api/social/publish/step", { method: "POST", headers: { "upstash-signature": "sig" }, body: JSON.stringify({ postId: "sp1", subAccountId: "sa1" }) }));
const post = (patch: Record<string, unknown> = {}) =>
  mem.seed("socialPosts/sp1", { subAccountId: "sa1", agencyId: "ag1", caption: "Hi", imageUrl: OWN, targets: ["facebook", "instagram"], status: "scheduled", ...patch });
const OWN = "https://firebasestorage.googleapis.com/v0/b/app.appspot.com/o/media%2Fsa1%2Fm1%2Fa.png?alt=media&token=t";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "app.appspot.com");
  mem.clear();
  meta.publishToFacebookPage.mockClear();
  meta.publishToInstagram.mockClear();
  mem.seed("subAccounts/sa1", { metaConfig: { connected: true, capabilities: { publish: true }, pageId: "page1", instagramBusinessAccountId: "ig1" } });
});

describe("social publish step, approved accounts", () => {
  it("the reviewed accounts still connected -> published", async () => {
    post({ approvedAccounts: { pageId: "page1", igUserId: "ig1" } });
    await run();
    expect(meta.publishToFacebookPage).toHaveBeenCalledTimes(1);
    expect(mem.read("socialPosts/sp1")!.status).toBe("published");
  });

  it.each([
    ["another Page", { pageId: "page2", igUserId: "ig1" }],
    ["another Instagram account", { pageId: "page1", igUserId: "ig_other" }],
  ])("approved for %s -> nothing published, marked failed", async (_label, approvedAccounts) => {
    post({ approvedAccounts });
    await run();
    expect(meta.publishToFacebookPage).not.toHaveBeenCalled();
    expect(meta.publishToInstagram).not.toHaveBeenCalled();
    expect(mem.read("socialPosts/sp1")).toMatchObject({ status: "failed", results: [{ error: "The connected account (or the image's storage) isn't what was approved; it was not published." }, expect.anything()] });
  });

  it("an approved post whose image isn't in the workspace's own storage -> nothing published", async () => {
    post({ approvedAccounts: { pageId: "page1", igUserId: "ig1" }, imageUrl: "https://x.io/a.png" });
    await run();
    expect(meta.publishToFacebookPage).not.toHaveBeenCalled();
    expect(mem.read("socialPosts/sp1")!.status).toBe("failed");
  });

  it("a person's own scheduled post (no approval record) publishes as before, any image host", async () => {
    post({ imageUrl: "https://x.io/a.png" });
    await run();
    expect(meta.publishToFacebookPage).toHaveBeenCalledTimes(1);
  });
});
