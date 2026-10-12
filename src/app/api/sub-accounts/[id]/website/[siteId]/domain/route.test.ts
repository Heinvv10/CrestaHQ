import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A live site's custom domain. Recording one widens where the sub-account's
 * Web Chat widget may run, so these pin who may do it (an admin of the
 * sub-account that owns the site, with the website gate on), what may be
 * allowed (the exact domain and its www/apex twin — never a gitpage host,
 * this app's own host or anything under it), and that removal takes back
 * only what the domain put there. Real route, real tenancy check and the
 * real AI-agent config module over the in-memory Firestore.
 */

const mem = createMemoryFirestore();
const claims: Record<string, Record<string, unknown>> = {
  u_admin: { status: "active", agencyId: "ag1" },
  u_member: { status: "active", agencyId: "ag1" },
  u_admin2: { status: "active", agencyId: "ag1" },
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async (uid: string) => ({ customClaims: claims[uid] ?? {} }) }),
}));

const { PUT, DELETE } = await import("./route");

const SITE = "subAccounts/sa1/website/site1";
const CHAT = "subAccounts/sa1/aiAgent/web-chat";
const PROFILE = "subAccounts/sa1/aiAgent/profile";
const OTHER_CHAT = "subAccounts/sa2/aiAgent/web-chat";
const LIVE = "https://acme.gitlab.io/site";

function call(
  method: "PUT" | "DELETE",
  body: unknown,
  opts: { uid?: string; sub?: string; siteId?: string } = {},
) {
  const uid = opts.uid ?? "u_admin";
  const sub = opts.sub ?? "sa1";
  const siteId = opts.siteId ?? "site1";
  const req = new Request(`https://app.test/api/sub-accounts/${sub}/website/${siteId}/domain`, {
    method,
    headers: { "content-type": "application/json", "x-user-uid": uid },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const params = { params: Promise.resolve({ id: sub, siteId }) };
  return method === "PUT" ? PUT(req, params) : DELETE(req, params);
}
const put = (domain: unknown, opts?: Parameters<typeof call>[2]) => call("PUT", { domain }, opts);
const del = (opts?: Parameters<typeof call>[2]) => call("DELETE", undefined, opts);

const seedSite = (path: string, patch: Record<string, unknown> = {}) =>
  mem.seed(path, {
    id: "site1",
    agencyId: "ag1",
    subAccountId: "sa1",
    status: "ready",
    gitpageJobId: "build_abc",
    liveUrl: LIVE,
    customDomain: null,
    ...patch,
  });
const seedChat = (path: string, allowedDomains: string[]) =>
  mem.seed(path, {
    enabled: true,
    webChat: { allowedDomains, welcomeMessage: "Hi", accentColor: "#123456", position: "left" },
  });
/**
 * Run `before` (or throw) when the n-th transaction of this request starts.
 * PUT runs two: the site write, then the allow-list edit; DELETE runs the
 * allow-list edit first, then the site write.
 */
function onTransaction(n: number, before: () => void) {
  const runTransaction = mem.db.runTransaction;
  let seen = 0;
  return vi.spyOn(mem.db, "runTransaction").mockImplementation((fn) => {
    seen += 1;
    if (seen === n) before();
    return runTransaction(fn);
  });
}
const allowed = (path = CHAT) =>
  (mem.read(path) as { webChat?: { allowedDomains?: string[] } } | undefined)?.webChat?.allowedDomains;

beforeEach(() => {
  mem.clear();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
  for (const sa of ["sa1", "sa2"]) {
    mem.seed(`subAccounts/${sa}`, { agencyId: "ag1", name: sa, websiteEnabledByAgency: true });
  }
  mem.seed("subAccounts/sa1/subAccountMembers/u_admin", { role: "admin", status: "active" });
  mem.seed("subAccounts/sa1/subAccountMembers/u_member", { role: "member", status: "active" });
  mem.seed("subAccounts/sa2/subAccountMembers/u_admin2", { role: "admin", status: "active" });
  mem.seed(PROFILE, { websiteUrl: LIVE });
  seedSite(SITE);
  seedChat(CHAT, ["acme.gitlab.io"]);
  seedChat(OTHER_CHAT, ["other.example"]);
});
afterEach(() => vi.unstubAllEnvs());

describe("PUT — record a custom domain", () => {
  it("allow-lists the www host and its apex twin, keeps what was there, and moves the chat bot to the domain", async () => {
    const res = await put("www.acme.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, customDomain: "www.acme.com", warnings: [] });
    expect(mem.read(SITE)).toMatchObject({
      customDomain: "www.acme.com",
      customDomainChatHosts: ["www.acme.com", "acme.com"],
      status: "ready",
    });
    expect(allowed()).toEqual(["acme.gitlab.io", "www.acme.com", "acme.com"]);
    // The rest of the chat config is untouched.
    expect(mem.read(CHAT)).toMatchObject({ enabled: true, webChat: { welcomeMessage: "Hi", position: "left" } });
    expect(mem.read(PROFILE)).toMatchObject({ websiteUrl: "https://www.acme.com/" });
    // Another tenant's allow-list never moves.
    expect(allowed(OTHER_CHAT)).toEqual(["other.example"]);
  });

  it.each([
    ["a two-label apex", "acme.com", ["acme.com", "www.acme.com"]],
    ["an apex under a multi-label suffix", "peakyoga.co.za", ["peakyoga.co.za", "www.peakyoga.co.za"]],
    ["www under a multi-label suffix", "www.peakyoga.co.za", ["www.peakyoga.co.za", "peakyoga.co.za"]],
    ["a subdomain", "shop.acme.com", ["shop.acme.com"]],
    ["a subdomain under a multi-label suffix", "shop.peakyoga.co.za", ["shop.peakyoga.co.za"]],
    ["www on a subdomain", "www.shop.peakyoga.co.za", ["www.shop.peakyoga.co.za"]],
  ])("allow-lists %s with exactly its www/apex twin, if it has one", async (_label, domain, hosts) => {
    seedChat(CHAT, []);
    expect((await put(domain)).status).toBe(200);
    expect(allowed()).toEqual(hosts);
  });

  it("stores the bare hostname whatever was pasted", async () => {
    expect((await put("  HTTPS://WWW.Acme.com:443/about?x=1#top ")).status).toBe(200);
    expect(mem.read(SITE)?.customDomain).toBe("www.acme.com");
  });

  it.each([
    ["a gitlab.io host", "acme.gitlab.io"],
    ["a github.io host", "www.acme.github.io"],
    ["a wildcard", "*.acme.com"],
    ["an IP address", "203.0.113.7"],
    ["a single label", "localhost"],
    ["a bare public suffix", "co.za"],
    ["the gitlab.io suffix itself", "gitlab.io"],
    ["a path-only value", "/acme"],
    ["this app's own host", "app.test"],
    ["this app's host with www", "www.app.test"],
    ["a host under this app (a funnel subdomain is another tenant's page)", "promo.app.test"],
    ["not a string", 42],
  ])("refuses %s and changes nothing", async (_label, domain) => {
    const site = mem.read(SITE);
    const chat = mem.read(CHAT);
    const res = await put(domain);
    expect(res.status).toBe(400);
    expect(mem.read(SITE)).toEqual(site);
    expect(mem.read(CHAT)).toEqual(chat);
    expect(mem.read(PROFILE)).toMatchObject({ websiteUrl: LIVE });
  });

  it("refuses every domain when the app's own host is unknown (it could not tell one from a platform host)", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect((await put("www.acme.com")).status).toBe(400);
    expect(mem.read(SITE)?.customDomain).toBeNull();
    expect(allowed()).toEqual(["acme.gitlab.io"]);
  });

  it("is refused (403) with the website gate off", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "sa1", websiteEnabledByAgency: false });
    expect((await put("www.acme.com")).status).toBe(403);
    expect(mem.read(SITE)?.customDomain).toBeNull();
    expect(allowed()).toEqual(["acme.gitlab.io"]);
  });

  it("is refused to a member who is not an admin, and to another sub-account's admin", async () => {
    expect((await put("www.acme.com", { uid: "u_member" })).status).toBe(403);
    expect((await put("www.acme.com", { uid: "u_admin2" })).status).toBe(403);
    expect(mem.read(SITE)?.customDomain).toBeNull();
    expect(allowed()).toEqual(["acme.gitlab.io"]);
  });

  it("only reaches a site the sub-account owns: another tenant's site is not found, and its allow-list never moves", async () => {
    // sa2's admin names sa2 but the site only exists under sa1.
    expect((await put("www.acme.com", { uid: "u_admin2", sub: "sa2" })).status).toBe(404);
    // A doc under sa1's path that is stamped with another tenant.
    seedSite(SITE, { subAccountId: "sa2" });
    expect((await put("www.acme.com")).status).toBe(404);
    expect(allowed()).toEqual(["acme.gitlab.io"]);
    expect(allowed(OTHER_CHAT)).toEqual(["other.example"]);
  });

  it("answers 404 for a site id that is not a document id, before any read", async () => {
    const doc = vi.spyOn(mem.db, "doc");
    try {
      expect((await put("www.acme.com", { siteId: ".." })).status).toBe(404);
      expect((await put("www.acme.com", { siteId: "__x__" })).status).toBe(404);
      expect((await del({ siteId: ".." })).status).toBe(404);
      expect(doc).not.toHaveBeenCalled();
    } finally {
      doc.mockRestore();
    }
    expect(allowed()).toEqual(["acme.gitlab.io"]);
  });

  it.each(["draft", "queued", "building", "failed"])("refuses (409) on a %s site", async (status) => {
    seedSite(SITE, { status });
    const res = await put("www.acme.com");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Add a custom domain once the site is live." });
    expect(mem.read(SITE)?.customDomain).toBeNull();
    expect(allowed()).toEqual(["acme.gitlab.io"]);
  });

  it("replacing a domain takes off only the hosts the old one added, and leaves entries it did not add", async () => {
    // old.com was listed by hand before www.old.com was saved.
    seedSite(SITE, { customDomain: "www.old.com", customDomainChatHosts: ["www.old.com"] });
    seedChat(CHAT, ["acme.gitlab.io", "old.com", "www.old.com", "partner.example"]);
    mem.seed(PROFILE, { websiteUrl: "https://www.old.com/" });
    expect((await put("www.new.com")).status).toBe(200);
    expect(allowed()).toEqual(["acme.gitlab.io", "old.com", "partner.example", "www.new.com", "new.com"]);
    expect(mem.read(SITE)?.customDomainChatHosts).toEqual(["www.new.com", "new.com"]);
    expect(mem.read(PROFILE)).toMatchObject({ websiteUrl: "https://www.new.com/" });
  });

  it("records only the hosts it added: one listed by hand is not claimed, and survives a later DELETE", async () => {
    seedChat(CHAT, ["acme.gitlab.io", "acme.com"]);
    expect((await put("www.acme.com")).status).toBe(200);
    expect(mem.read(SITE)?.customDomainChatHosts).toEqual(["www.acme.com"]);
    expect((await del()).status).toBe(200);
    expect(allowed()).toEqual(["acme.gitlab.io", "acme.com"]);
  });

  it("swapping www for its apex records both hosts again, so a DELETE then takes both off", async () => {
    expect((await put("www.acme.com")).status).toBe(200);
    expect((await put("acme.com")).status).toBe(200);
    expect([...(mem.read(SITE)?.customDomainChatHosts as string[])].sort()).toEqual(["acme.com", "www.acme.com"]);
    expect((await del()).status).toBe(200);
    expect(allowed()).toEqual(["acme.gitlab.io"]);
  });

  it("a re-save of the same domain keeps what it recorded", async () => {
    expect((await put("www.acme.com")).status).toBe(200);
    expect((await put("www.acme.com")).status).toBe(200);
    expect(mem.read(SITE)?.customDomainChatHosts).toEqual(["www.acme.com", "acme.com"]);
    expect((await del()).status).toBe(200);
    expect(allowed()).toEqual(["acme.gitlab.io"]);
  });

  it("records the domain and warns when the allow-list write fails", async () => {
    const spy = onTransaction(2, () => {
      throw new Error("deadline exceeded");
    });
    let res: Response;
    try {
      res = await put("www.acme.com");
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings).toEqual([
      "The chat widget's allowed domains were not updated — add the domain in the Web Chat settings.",
    ]);
    expect(mem.read(SITE)).toMatchObject({ customDomain: "www.acme.com", customDomainChatHosts: ["www.acme.com", "acme.com"] });
    expect(allowed()).toEqual(["acme.gitlab.io"]);
  });

  it("re-checks the 25-entry cap inside the allow-list transaction: a list filled meanwhile is not overflowed", async () => {
    const full = Array.from({ length: 25 }, (_, i) => `site${i}.example`);
    const spy = onTransaction(2, () => seedChat(CHAT, full));
    let res: Response;
    try {
      res = await put("www.acme.com");
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatch(/filled up \(25\)/);
    expect(allowed()).toEqual(full);
  });

  it("leaves a chat bot that points somewhere else alone", async () => {
    mem.seed(PROFILE, { websiteUrl: "https://elsewhere.example/" });
    expect((await put("www.acme.com")).status).toBe(200);
    expect(mem.read(PROFILE)).toMatchObject({ websiteUrl: "https://elsewhere.example/" });
  });

  it("refuses (409) a domain that would overflow the 25-entry allow-list, writing nothing", async () => {
    const full = Array.from({ length: 24 }, (_, i) => `site${i}.example`);
    seedChat(CHAT, full);
    expect((await put("www.acme.com")).status).toBe(409);
    expect(mem.read(SITE)?.customDomain).toBeNull();
    expect(allowed()).toEqual(full);
  });

  it.each([
    ["rebuilt", { status: "queued", gitpageJobId: "build_new" }],
    ["rebuilt and live again", { gitpageJobId: "build_new" }],
    ["no longer live", { status: "failed" }],
  ])("writes nothing when the site was %s between its read and its write", async (_label, change) => {
    const runTransaction = mem.db.runTransaction;
    let raced = false;
    const spy = vi.spyOn(mem.db, "runTransaction").mockImplementation((fn) => {
      if (!raced) {
        raced = true;
        mem.seed(SITE, { ...mem.read(SITE), ...change });
      }
      return runTransaction(fn);
    });
    const res = await put("www.acme.com");
    spy.mockRestore();
    expect(raced).toBe(true);
    expect(res.status).toBe(409);
    expect(mem.read(SITE)?.customDomain).toBeNull();
    expect(allowed()).toEqual(["acme.gitlab.io"]);
  });

  it("writes nothing when the domain changed between its read and its write", async () => {
    // Let the request read the site, then land another save before it commits.
    const runTransaction = mem.db.runTransaction;
    let raced = false;
    const spy = vi.spyOn(mem.db, "runTransaction").mockImplementation((fn) => {
      if (!raced) {
        raced = true;
        mem.seed(SITE, { ...mem.read(SITE), customDomain: "www.racer.com" });
      }
      return runTransaction(fn);
    });
    const res = await put("www.acme.com");
    spy.mockRestore();
    expect(raced).toBe(true);
    expect(res.status).toBe(409);
    expect(mem.read(SITE)?.customDomain).toBe("www.racer.com");
    expect(allowed()).toEqual(["acme.gitlab.io"]);
  });
});

describe("DELETE — clear the custom domain", () => {
  beforeEach(() => {
    seedSite(SITE, { customDomain: "www.acme.com", customDomainChatHosts: ["www.acme.com", "acme.com"] });
    seedChat(CHAT, ["acme.gitlab.io", "www.acme.com", "acme.com", "partner.example"]);
    mem.seed(PROFILE, { websiteUrl: "https://www.acme.com/" });
  });

  it("takes the domain's hosts off the allow-list, keeps the rest, and points the chat bot back at the live URL", async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(mem.read(SITE)).toMatchObject({ customDomain: null, customDomainChatHosts: null });
    expect(allowed()).toEqual(["acme.gitlab.io", "partner.example"]);
    expect(mem.read(PROFILE)).toMatchObject({ websiteUrl: LIVE });
  });

  it("leaves a chat bot that points somewhere else alone", async () => {
    mem.seed(PROFILE, { websiteUrl: "https://elsewhere.example/" });
    expect((await del()).status).toBe(200);
    expect(mem.read(PROFILE)).toMatchObject({ websiteUrl: "https://elsewhere.example/" });
  });

  it("does not clear a domain that another save replaced while it was being removed", async () => {
    const runTransaction = mem.db.runTransaction;
    let raced = false;
    const spy = vi.spyOn(mem.db, "runTransaction").mockImplementation((fn) => {
      if (!raced) {
        raced = true;
        mem.seed(SITE, { ...mem.read(SITE), customDomain: "www.racer.com" });
      }
      return runTransaction(fn);
    });
    let res: Response;
    try {
      res = await del();
    } finally {
      spy.mockRestore();
    }
    expect(raced).toBe(true);
    expect(res.status).toBe(409);
    expect(mem.read(SITE)?.customDomain).toBe("www.racer.com");
  });

  it("still works with the website gate off — a domain can always be taken back", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "sa1", websiteEnabledByAgency: false });
    expect((await del()).status).toBe(200);
    expect(allowed()).toEqual(["acme.gitlab.io", "partner.example"]);
  });

  it("is refused to a non-admin and to another tenant", async () => {
    expect((await del({ uid: "u_member" })).status).toBe(403);
    expect((await del({ uid: "u_admin2", sub: "sa2" })).status).toBe(404);
    expect(mem.read(SITE)?.customDomain).toBe("www.acme.com");
    expect(allowed()).toEqual(["acme.gitlab.io", "www.acme.com", "acme.com", "partner.example"]);
  });

  it("keeps the domain recorded when the allow-list cannot be updated, so the removal can be retried", async () => {
    const spy = onTransaction(1, () => {
      throw new Error("deadline exceeded");
    });
    let res: Response;
    try {
      res = await del();
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(502);
    expect(mem.read(SITE)?.customDomain).toBe("www.acme.com");
    expect(allowed()).toEqual(["acme.gitlab.io", "www.acme.com", "acme.com", "partner.example"]);
  });

  it("clears a domain on a site that is no longer live (a reset keeps it)", async () => {
    seedSite(SITE, {
      status: "draft",
      gitpageJobId: null,
      liveUrl: null,
      customDomain: "www.acme.com",
      customDomainChatHosts: ["www.acme.com", "acme.com"],
    });
    expect((await del()).status).toBe(200);
    expect(mem.read(SITE)?.customDomain).toBeNull();
    expect(allowed()).toEqual(["acme.gitlab.io", "partner.example"]);
  });

  it("is a no-op on a site with no custom domain", async () => {
    seedSite(SITE);
    const chat = mem.read(CHAT);
    expect((await del()).status).toBe(200);
    expect(mem.read(CHAT)).toEqual(chat);
  });
});
