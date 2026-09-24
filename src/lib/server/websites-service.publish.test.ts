import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * publishCallback never throws — it resolves null when the first build poll
 * could not be queued. The site must then settle as failed with the reason
 * the builder UI shows (and keep its gitpage job id so Re-check now can
 * resume), not sit at "queued" forever.
 */

vi.mock("server-only", () => ({}));
const publishCallback = vi.hoisted(() => vi.fn());
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback,
}));
vi.mock("@/lib/gitpage/client", () => ({
  GitpageError: class extends Error {},
  gitpageIsConfigured: () => true,
  submitBuild: async () => ({ formResponseId: "fr_1" }),
}));
vi.mock("@/lib/gitpage/heartbeat", () => ({
  markGitpageBuildSucceeded: async () => {},
  markGitpageKeyInvalid: async () => {},
}));
vi.mock("@/lib/website/validation", () => ({ validateWebsiteConfig: () => ({}) }));

const docs = new Map<string, Record<string, unknown>>();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      set: async (d: Record<string, unknown>) =>
        void docs.set(path, { ...(docs.get(path) ?? {}), ...d }),
      update: async (d: Record<string, unknown>) =>
        void docs.set(path, { ...(docs.get(path) ?? {}), ...d }),
    }),
  }),
}));

const { submitWebsiteBuildForSubAccount } = await import("./websites-service");
const { blankWebsiteConfig } = await import("@/types/website");

const SITE = "subAccounts/sa1/website/site1";

const build = () =>
  submitWebsiteBuildForSubAccount({
    subAccountId: "sa1",
    siteId: "site1",
    config: blankWebsiteConfig(),
    buildByUid: "u1",
  });

beforeEach(() => {
  docs.clear();
  docs.set("subAccounts/sa1", { agencyId: "ag1", websiteEnabledByAgency: true, name: "Acme" });
  docs.set(SITE, { status: "draft" });
  publishCallback.mockReset().mockResolvedValue({ messageId: "m1" });
});

describe("submitWebsiteBuildForSubAccount — first poll not queued", () => {
  it("settles the site as failed with the Re-check reason when the publish resolves null", async () => {
    publishCallback.mockResolvedValue(null);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await build();
    const site = docs.get(SITE);
    expect(site?.status).toBe("failed");
    expect(site?.errorMessage).toBe("Couldn't schedule the next poll. Try Re-check now or Rebuild.");
    expect(site?.gitpageJobId).toBe("fr_1");
    expect(error).toHaveBeenCalledWith("[website/build] first poll not queued sa=sa1 site=site1");
    error.mockRestore();
  });

  it("stays queued when the first poll is queued", async () => {
    await build();
    expect(publishCallback).toHaveBeenCalledTimes(1);
    expect(docs.get(SITE)?.status).toBe("queued");
  });
});
