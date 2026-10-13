import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { blankPremiumDetails, sampleWebsiteConfig, type WebsiteConfig } from "@/types/website";

/**
 * A build's premium input is untrusted JSON. A malformed value must be a 400
 * with field errors BEFORE the hourly build slot is reserved and before
 * gitpage is called — not a TypeError thrown while building the request,
 * after the slot is spent. Real service + real validation over the
 * in-memory Firestore; only the outbound fetch and QStash are stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async () => ({ email: "owner@acme.test" }) }),
}));
vi.mock("@/lib/automations/qstash", () => ({ qstashIsConfigured: () => true, publishCallback: vi.fn(async () => ({ messageId: "m1" })) }));
vi.mock("@/lib/gitpage/heartbeat", () => ({
  markGitpageBuildSucceeded: async () => {},
  markGitpageKeyInvalid: async () => {},
}));

const { submitWebsiteBuildForSubAccount, websiteLimitsPath } = await import("./websites-service");

const SITE = "subAccounts/sa1/website/site1";
const fetchMock = vi.fn();
const ORIGINAL = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL, app: process.env.NEXT_PUBLIC_APP_URL };

const build = (patch: Record<string, unknown>) =>
  submitWebsiteBuildForSubAccount({
    subAccountId: "sa1",
    siteId: "site1",
    config: { ...sampleWebsiteConfig(), ...patch } as unknown as WebsiteConfig,
    buildByUid: "u1",
  });

beforeEach(() => {
  process.env.GITPAGE_API_KEY = "gp_test_key";
  process.env.GITPAGE_API_URL = "https://gitpage.test";
  process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.test/";
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", websiteEnabledByAgency: true, name: "Acme" });
  mem.seed(SITE, { id: "site1", agencyId: "ag1", subAccountId: "sa1", status: "draft" });
  fetchMock.mockReset().mockImplementation(async () =>
    Response.json({ formResponseId: "build_abc", pollUrl: "https://gitpage.test/s/build_abc", estimatedDurationSeconds: 1200 }, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of [["GITPAGE_API_KEY", ORIGINAL.key], ["GITPAGE_API_URL", ORIGINAL.url], ["NEXT_PUBLIC_APP_URL", ORIGINAL.app]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("submitWebsiteBuildForSubAccount — malformed premium input", () => {
  it.each([
    ["a number tagline", { premium_details: { ...blankPremiumDetails(), tagline: 123 } }, "premium_details.tagline"],
    ["an array brand voice", { premium_details: { ...blankPremiumDetails(), brand_voice: ["a"] } }, "premium_details.brand_voice"],
    ["an object reference_notes", { premium_details: { ...blankPremiumDetails(), reference_notes: { length: 0 } } }, "premium_details.reference_notes"],
    ["premium_details as a string", { premium_details: "tagline" }, "premium_details"],
    ["an unsafe social link", { premium_details: { ...blankPremiumDetails(), social_links: 'IG | https://a"onfocus="x' } }, "premium_details.social_links"],
    ["a concept id that is a path", { concept: "../../v1/keys" }, "concept"],
  ])("refuses %s with a 400 before the hourly slot is taken or gitpage is called", async (_label, patch, field) => {
    const err = await build(patch).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, fieldErrors: { [field]: expect.any(String) } });
    expect(mem.read(websiteLimitsPath("sa1"))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the same build with well-formed premium input goes through (the refusals above are the input, not the harness)", async () => {
    await build({ premium_details: { ...blankPremiumDetails(), tagline: "Stronger", social_links: "IG | https://instagram.com/acme" }, concept: "atelier" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ count: 1 });
  });
});
