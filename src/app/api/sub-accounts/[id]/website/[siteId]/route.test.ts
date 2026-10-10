import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * PATCH saves the website wizard's draft. It must refuse while a build is in
 * flight — a save then would change the config a running gitpage job was
 * submitted with — and it never touches status, job id or live URL. Real
 * route + real tenancy check over the in-memory Firestore.
 */

const mem = createMemoryFirestore();
const claims: Record<string, Record<string, unknown>> = {
  u_admin: { status: "active", agencyId: "ag1" },
  u_member: { status: "active", agencyId: "ag1" },
  u_outsider: { status: "active", agencyId: "ag9" },
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async (uid: string) => ({ customClaims: claims[uid] ?? {} }) }),
}));

const { PATCH } = await import("./route");

const SITE = "subAccounts/sa1/website/site1";

function patch(body: unknown, opts: { uid?: string; siteId?: string; raw?: string } = {}) {
  const uid = "uid" in opts ? opts.uid : "u_admin";
  return PATCH(
    new Request("https://app.test/api/sub-accounts/sa1/website/site1", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(uid ? { "x-user-uid": uid } : {}) },
      body: opts.raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "sa1", siteId: opts.siteId ?? "site1" }) },
  );
}

const seedSite = (status: string) =>
  mem.seed(SITE, {
    id: "site1",
    agencyId: "ag1",
    subAccountId: "sa1",
    status,
    gitpageJobId: status === "draft" ? null : "build_abc",
    liveUrl: status === "ready" ? "https://acme.gitlab.io/site" : null,
    config: { heading: "Before" },
    wizardStep: "start",
  });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme" });
  mem.seed("subAccounts/sa1/subAccountMembers/u_admin", { role: "admin", status: "active" });
  mem.seed("subAccounts/sa1/subAccountMembers/u_member", { role: "member", status: "active" });
});

describe("PATCH /api/sub-accounts/[id]/website/[siteId] — draft save", () => {
  it.each(["queued", "building"])("refuses with 409 while the build is %s, leaving the doc as it was", async (status) => {
    seedSite(status);
    const before = mem.read(SITE);
    const res = await patch({ config: { heading: "After" }, wizardStep: "look" });
    expect(res.status).toBe(409);
    expect(mem.read(SITE)).toEqual(before);
  });

  it.each(["draft", "failed", "ready"])("saves the draft and the step on a %s site without touching its build state", async (status) => {
    seedSite(status);
    const before = mem.read(SITE)!;
    const res = await patch({ config: { heading: "After" }, wizardStep: "look" });
    expect(res.status).toBe(200);
    expect(mem.read(SITE)).toMatchObject({
      config: { heading: "After" },
      wizardStep: "look",
      status,
      gitpageJobId: before.gitpageJobId,
      liveUrl: before.liveUrl,
    });
  });

  it("keeps the system fields server-owned whatever the draft says", async () => {
    seedSite("draft");
    await patch({ config: { heading: "After", site_type: "Other", astra_theme: true } });
    expect(mem.read(SITE)?.config).toEqual({ heading: "After", site_type: "LocalSite", astra_theme: false });
  });

  it("stores only a known wizard step", async () => {
    seedSite("draft");
    await patch({ config: { heading: "After" }, wizardStep: "../admin" });
    expect(mem.read(SITE)?.wizardStep).toBeNull();
  });

  it("refuses a body with no config object, and one too large to be a draft", async () => {
    seedSite("draft");
    const before = mem.read(SITE);
    expect((await patch({ wizardStep: "look" })).status).toBe(400);
    expect((await patch({ config: ["not", "an", "object"] })).status).toBe(400);
    expect((await patch(null, { raw: "{" })).status).toBe(400);
    expect((await patch({ config: { heading: "x".repeat(100_001) } })).status).toBe(413);
    expect(mem.read(SITE)).toEqual(before);
  });

  it("answers 404 for a site that does not exist in this sub-account", async () => {
    seedSite("draft");
    expect((await patch({ config: { heading: "After" } }, { siteId: "nope" })).status).toBe(404);
  });

  it("is admin-only: no session, a non-admin member and another agency's user are all refused", async () => {
    seedSite("draft");
    const before = mem.read(SITE);
    expect((await patch({ config: { heading: "After" } }, { uid: undefined })).status).toBe(401);
    expect((await patch({ config: { heading: "After" } }, { uid: "u_member" })).status).toBe(403);
    expect((await patch({ config: { heading: "After" } }, { uid: "u_outsider" })).status).toBe(403);
    expect(mem.read(SITE)).toEqual(before);
  });
});
