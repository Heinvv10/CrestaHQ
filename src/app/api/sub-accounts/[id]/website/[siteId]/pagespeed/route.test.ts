import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The post-publish PageSpeed check is a public path: QStash's signature,
 * bound to this route's URL for this one site, is its only credential. These
 * drive the real route, the real QStash verifier (signatures minted here the
 * way Upstash mints them) and the real PageSpeed runner over the in-memory
 * Firestore; only Google's answer is stubbed.
 */

const KEY = "sig_current_test_key";
const APP = "https://app.test";
vi.stubEnv("QSTASH_TOKEN", "qstash_token_test");
vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", KEY);
vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "sig_next_test_key");
vi.stubEnv("QSTASH_LEGACY_CURRENT_SIGNING_KEY", "");
vi.stubEnv("QSTASH_LEGACY_NEXT_SIGNING_KEY", "");
vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
vi.stubEnv("PAGESPEED_API_KEY", "");

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { POST } = await import("./route");

const SITE = "subAccounts/sa1/website/site1";
const URL_FOR = (sa: string, site: string) => `${APP}/api/sub-accounts/${sa}/website/${site}/pagespeed`;

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");
function sign(url: string, body: string, key = KEY): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "Upstash",
      sub: url,
      iat: now,
      nbf: now,
      exp: now + 300,
      jti: `j${Math.random()}`,
      body: createHash("sha256").update(body, "utf8").digest("base64url"),
    }),
  );
  const sig = createHmac("sha256", key).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function post(opts: { body?: string; signature?: string | null; sa?: string; site?: string } = {}) {
  const sa = opts.sa ?? "sa1";
  const site = opts.site ?? "site1";
  const body = opts.body ?? JSON.stringify({ subAccountId: sa, siteId: site });
  const signature = opts.signature === undefined ? sign(URL_FOR(sa, site), body) : opts.signature;
  return POST(
    new Request(URL_FOR(sa, site), {
      method: "POST",
      headers: { "content-type": "application/json", ...(signature === null ? {} : { "upstash-signature": signature }) },
      body,
    }),
    { params: Promise.resolve({ id: sa, siteId: site }) },
  );
}

const PSI_OK = {
  lighthouseResult: {
    categories: {
      performance: { score: 0.91 },
      seo: { score: 1 },
      accessibility: { score: 0.876 },
      "best-practices": { score: null },
    },
  },
};

beforeEach(() => {
  mem.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json(PSI_OK));
  mem.seed("subAccounts/sa1", { agencyId: "ag1", websiteEnabledByAgency: true });
  mem.seed(SITE, {
    id: "site1",
    agencyId: "ag1",
    subAccountId: "sa1",
    status: "ready",
    gitpageJobId: "build_abc",
    liveUrl: "https://acme.gitlab.io/site",
  });
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST …/website/[siteId]/pagespeed", () => {
  it("a signed delivery scores the live site and stores it", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      pagespeed: { performance: 91, seo: 100, accessibility: 88, bestPractices: null, error: null },
    });
    expect(mem.read(SITE)?.pagespeed).toMatchObject({ url: "https://acme.gitlab.io/site", performance: 91 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a delivery with no signature, a forged one, or a body changed after signing — nothing is fetched or written", async () => {
    const body = JSON.stringify({ subAccountId: "sa1", siteId: "site1" });
    expect((await post({ signature: null })).status).toBe(401);
    expect((await post({ signature: sign(URL_FOR("sa1", "site1"), body, "not-the-key") })).status).toBe(401);
    expect((await post({ signature: "garbage" })).status).toBe(401);
    const tampered = JSON.stringify({ subAccountId: "sa1", siteId: "site1", x: 1 });
    expect((await post({ body: tampered, signature: sign(URL_FOR("sa1", "site1"), body) })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.read(SITE)?.pagespeed).toBeUndefined();
  });

  it("refuses a signature minted for another route or another site (the signature is bound to this URL)", async () => {
    const body = JSON.stringify({ subAccountId: "sa1", siteId: "site1" });
    const poll = `${APP}/api/sub-accounts/sa1/website/site1/poll`;
    expect((await post({ signature: sign(poll, body) })).status).toBe(401);
    expect((await post({ signature: sign(URL_FOR("sa1", "site2"), body) })).status).toBe(401);
    expect((await post({ signature: sign(URL_FOR("sa2", "site1"), body) })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a signed body whose ids are not the path's", async () => {
    const body = JSON.stringify({ subAccountId: "sa2", siteId: "site1" });
    expect((await post({ body })).status).toBe(400);
    expect((await post({ body: "{" })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed with no signing keys (503) and with no app URL to bind to (401)", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect((await post({ signature: sign(`/api/sub-accounts/sa1/website/site1/pagespeed`, "{}") })).status).toBe(401);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "");
    try {
      expect((await post()).status).toBe(503);
    } finally {
      vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", KEY);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that is not a document id, before anything is read", async () => {
    expect((await post({ site: ".." })).status).toBe(404);
    expect((await post({ sa: "__x__" })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing (and is acknowledged) once the website gate is off", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", websiteEnabledByAgency: false });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "gate-off" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.read(SITE)?.pagespeed).toBeUndefined();
  });

  it("does nothing for a site that is not live", async () => {
    mem.seed(SITE, { ...mem.read(SITE), status: "building" });
    const res = await post();
    expect(await res.json()).toEqual({ ok: true, ignored: "site-not-live" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
