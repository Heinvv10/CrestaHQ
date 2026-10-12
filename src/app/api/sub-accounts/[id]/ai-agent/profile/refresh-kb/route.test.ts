import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * POST …/ai-agent/profile/refresh-kb with `{ siteId }`: re-scrape one of the
 * sub-account's built websites into the AI knowledge base. A website-builder
 * action, so it answers to the website gate as the builder's routes do; the
 * site id goes into a Firestore path, so it must be a doc id; and the site
 * must be this sub-account's and live. Real route over the in-memory
 * Firestore; only the auth check and Firecrawl's scrape are stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const ADMIN = { uid: "u_admin", subAccountId: "sa1", subAccountRole: "admin" };
const auth = vi.hoisted(() => ({ impl: null as null | (() => unknown) }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => (auth.impl ? auth.impl() : ADMIN),
}));
const scrape = vi.hoisted(() => vi.fn());
vi.mock("@/lib/firecrawl/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/firecrawl/client")>();
  return { ...real, firecrawlIsConfigured: () => true, scrapeUrl: scrape };
});

const { POST } = await import("./route");

const SITE = "subAccounts/sa1/website/site1";
const PROFILE = "subAccounts/sa1/aiAgent/profile";
const LIVE = "https://acme-site-1a2b3c.gitlab.io/";

const refresh = (body?: unknown, id = "sa1") =>
  POST(
    new Request(`https://app.test/api/sub-accounts/${id}/ai-agent/profile/refresh-kb`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id }) },
  );

const seedSub = (patch: Record<string, unknown> = {}) =>
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: true, ...patch });

const seedSite = (patch: Record<string, unknown> = {}) =>
  mem.seed(SITE, {
    id: "site1",
    agencyId: "ag1",
    subAccountId: "sa1",
    status: "ready",
    liveUrl: LIVE,
    config: { build_type: "local", local_page_selections: { services: true, contact: false } },
    ...patch,
  });

beforeEach(() => {
  auth.impl = null;
  mem.clear();
  seedSub();
  seedSite();
  scrape.mockReset().mockImplementation(async (url: string) => ({ markdown: `content of ${url}` }));
});
afterEach(() => vi.restoreAllMocks());

describe("refresh-kb from a built site ({ siteId })", () => {
  it("scrapes the site's home page and each selected content page into the knowledge base", async () => {
    const res = await refresh({ siteId: "site1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pages: 2, failures: [] });
    expect(scrape.mock.calls.map((c) => c[0])).toEqual([LIVE, `${LIVE}services.html`]);
    expect(mem.read(PROFILE)).toMatchObject({
      websiteUrl: LIVE,
      websiteKb: `## Home page\n\ncontent of ${LIVE}\n\n## Services page\n\ncontent of ${LIVE}services.html`,
      websiteKbSource: "firecrawl",
      websiteKbSiteId: "site1",
    });
  });

  it.each([
    ["switched off", { websiteEnabledByAgency: false }],
    ["absent", { websiteEnabledByAgency: undefined }],
    ["truthy but not literally true", { websiteEnabledByAgency: "true" }],
  ])("is refused with 403 when the workspace's website gate is %s, and scrapes nothing", async (_label, patch) => {
    seedSub(patch);
    const res = await refresh({ siteId: "site1" });
    expect(res.status).toBe(403);
    expect(scrape).not.toHaveBeenCalled();
    expect(mem.read(PROFILE)).toBeUndefined();
  });

  it.each([
    ["a path", "x/y/z"],
    ["a dot segment", ".."],
    ["a single dot", "."],
    ["a climb into another tenant", "../../sa2/website/site9"],
    ["a reserved name", "__x__"],
    ["over-long", "a".repeat(2000)],
  ])("answers 404 for a site id that is %s, before any read", async (_label, siteId) => {
    const get = vi.spyOn(mem.db, "doc");
    const res = await refresh({ siteId });
    expect(res.status).toBe(404);
    expect(get.mock.calls.map((c) => c[0])).not.toContainEqual(expect.stringContaining(siteId));
    expect(scrape).not.toHaveBeenCalled();
  });

  it("answers 404 for a doc under this path that belongs to another sub-account", async () => {
    seedSite({ subAccountId: "saB" });
    const res = await refresh({ siteId: "site1" });
    expect(res.status).toBe(404);
    expect(scrape).not.toHaveBeenCalled();
  });

  it("answers 400 for a site that is not live", async () => {
    seedSite({ status: "building" });
    const res = await refresh({ siteId: "site1" });
    expect(res.status).toBe(400);
    expect(scrape).not.toHaveBeenCalled();
  });

  it("keeps the previous knowledge base when no page could be read", async () => {
    mem.seed(PROFILE, { websiteKb: "old snapshot" });
    scrape.mockRejectedValue(new Error("blocked"));
    const res = await refresh({ siteId: "site1" });
    expect(res.status).toBe(502);
    expect(mem.read(PROFILE)).toMatchObject({ websiteKb: "old snapshot" });
  });

  it("without a siteId it still refreshes from the profile's own website URL, gate or no gate", async () => {
    seedSub({ websiteEnabledByAgency: false });
    mem.seed(PROFILE, { websiteUrl: "https://acme.example/" });
    const res = await refresh();
    expect(res.status).toBe(200);
    expect(scrape.mock.calls.map((c) => c[0])).toEqual(["https://acme.example/"]);
  });
});

describe("refresh-kb { siteId } against another tenant or a non-admin (breaker, PR #400)", () => {
  beforeEach(() => {
    mem.seed("subAccounts/sa2/website/site9", { subAccountId: "sa2", status: "ready", liveUrl: "https://victim.example/" });
  });

  it("a site id that exists only under another sub-account is 404, and its site is never scraped", async () => {
    expect((await refresh({ siteId: "site9" })).status).toBe(404);
    expect(scrape).not.toHaveBeenCalled();
  });

  it("a caller the admin check refuses gets its answer and nothing is scraped", async () => {
    const { NextResponse } = await import("next/server");
    auth.impl = () => NextResponse.json({ error: "forbidden" }, { status: 403 });
    expect((await refresh({ siteId: "site1" })).status).toBe(403);
    expect(scrape).not.toHaveBeenCalled();
  });

  it("a siteId that is not a string falls back to the profile's URL, never a site path", async () => {
    mem.seed(PROFILE, { websiteUrl: "https://acme.example/" });
    await refresh({ siteId: { toString: "x" } });
    await refresh({ siteId: 123 });
    expect(scrape.mock.calls.map((c) => c[0])).toEqual(["https://acme.example/", "https://acme.example/"]);
  });
});
