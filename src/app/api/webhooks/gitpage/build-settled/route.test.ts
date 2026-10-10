import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The gitpage `build.settled` callback is a public, session-less route: the
 * only thing between the internet and a site doc's status is the HMAC-SHA256
 * of the raw body under GITPAGE_API_KEY. Real route + real settle service
 * over the in-memory Firestore; nothing below mocks the verification.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => ({ messageId: "m1" }),
}));
vi.mock("@/lib/gitpage/heartbeat", () => ({
  markGitpageBuildSucceeded: async () => {},
  markGitpageKeyInvalid: async () => {},
}));

const { POST } = await import("./route");

const KEY = "gp_test_key";
const SITE = "subAccounts/sa1/website/site1";
const JOB = "build_abc";

const payload = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: "build.settled",
    formResponseId: JOB,
    subAccountId: "sa1",
    status: "Published",
    statusPhase: "completed",
    pagesUrl: "https://acme.gitlab.io/site",
    quality: "premium",
    pageId: "page_42",
    ...patch,
  });

const sign = (body: string, key = KEY) =>
  `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

function post(body: string, signature?: string): Promise<Response> {
  return POST(
    new Request("https://app.test/api/webhooks/gitpage/build-settled", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature === undefined ? {} : { "x-gitpage-signature": signature }),
      },
      body,
    }),
  ) as unknown as Promise<Response>;
}

const ORIGINAL_KEY = process.env.GITPAGE_API_KEY;
beforeEach(() => {
  process.env.GITPAGE_API_KEY = KEY;
  mem.clear();
  mem.seed(SITE, {
    id: "site1",
    agencyId: "ag1",
    subAccountId: "sa1",
    status: "building",
    gitpageJobId: JOB,
    liveUrl: null,
    pollAttempts: 3,
    quality: "premium",
  });
});
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.GITPAGE_API_KEY;
  else process.env.GITPAGE_API_KEY = ORIGINAL_KEY;
});

/** The seeded site, exactly as the tests left it before the request. */
const untouched = { status: "building", liveUrl: null, pollAttempts: 3 };

describe("POST /api/webhooks/gitpage/build-settled — signature", () => {
  it("accepts a body signed with GITPAGE_API_KEY and settles the site", async () => {
    const body = payload();
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, settled: "ready" });
    expect(mem.read(SITE)).toMatchObject({
      status: "ready",
      liveUrl: "https://acme.gitlab.io/site",
      gitpagePageId: "page_42",
      statusPhase: "completed",
    });
  });

  it("accepts the bare hex digest too (no sha256= prefix)", async () => {
    const body = payload();
    const res = await post(body, sign(body).slice("sha256=".length));
    expect(res.status).toBe(200);
    expect(mem.read(SITE)).toMatchObject({ status: "ready" });
  });

  it("refuses a body signed with the wrong secret, writing nothing", async () => {
    const body = payload();
    const res = await post(body, sign(body, "gp_someone_elses_key"));
    expect(res.status).toBe(401);
    expect(mem.read(SITE)).toMatchObject(untouched);
  });

  it("refuses a body that was changed after signing, writing nothing", async () => {
    const signature = sign(payload({ status: "failed", error: "boom" }));
    const res = await post(payload(), signature);
    expect(res.status).toBe(401);
    expect(mem.read(SITE)).toMatchObject(untouched);
  });

  it("refuses a request with no signature header, writing nothing", async () => {
    const res = await post(payload());
    expect(res.status).toBe(401);
    expect(mem.read(SITE)).toMatchObject(untouched);
  });

  it("refuses an empty signature and a truncated one", async () => {
    const body = payload();
    expect((await post(body, "")).status).toBe(401);
    expect((await post(body, "sha256=")).status).toBe(401);
    expect((await post(body, sign(body).slice(0, -2))).status).toBe(401);
    expect(mem.read(SITE)).toMatchObject(untouched);
  });

  it("verifies the raw bytes, not a re-serialised parse: reformatted JSON is refused", async () => {
    const body = payload();
    const reformatted = JSON.stringify(JSON.parse(body), null, 2);
    expect(reformatted).not.toBe(body);
    const res = await post(reformatted, sign(body));
    expect(res.status).toBe(401);
    expect(mem.read(SITE)).toMatchObject(untouched);
  });

  it("checks the signature before parsing: a signed non-JSON body is acknowledged, an unsigned one refused", async () => {
    const garbage = "not json {";
    expect((await post(garbage)).status).toBe(401);
    const res = await post(garbage, sign(garbage));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "invalid-json" });
  });

  it("answers 503 when the deployment has no GITPAGE_API_KEY, even for a request signed with an empty key", async () => {
    delete process.env.GITPAGE_API_KEY;
    const body = payload();
    const res = await post(body, sign(body, ""));
    expect(res.status).toBe(503);
    expect(mem.read(SITE)).toMatchObject(untouched);
  });
});

describe("POST /api/webhooks/gitpage/build-settled — what a signed callback may touch", () => {
  const signed = (patch: Record<string, unknown> = {}) => {
    const body = payload(patch);
    return post(body, sign(body));
  };

  it("settles a failed build with gitpage's error", async () => {
    const res = await signed({ status: "failed", pagesUrl: null, error: "Deploy failed.", failedStage: "deploy" });
    expect(await res.json()).toEqual({ ok: true, settled: "failed" });
    expect(mem.read(SITE)).toMatchObject({ status: "failed", errorMessage: "Deploy failed.", statusPhase: "deploy" });
  });

  it("ignores a duplicate delivery once the site has settled", async () => {
    await signed();
    const settled = mem.read(SITE);
    const res = await signed({ pagesUrl: "https://elsewhere.example" });
    expect(await res.json()).toEqual({ ok: true, ignored: "already-settled" });
    expect(mem.read(SITE)).toEqual(settled);
  });

  it("ignores a job id that belongs to a site in another sub-account", async () => {
    mem.seed("subAccounts/sa2/website/siteB", {
      id: "siteB", agencyId: "ag1", subAccountId: "sa2", status: "building", gitpageJobId: "build_other",
    });
    const res = await signed({ formResponseId: "build_other" });
    expect(await res.json()).toEqual({ ok: true, ignored: "site-not-found" });
    expect(mem.read("subAccounts/sa2/website/siteB")).toMatchObject({ status: "building" });
    expect(mem.read(SITE)).toMatchObject(untouched);
  });

  it("ignores a callback with no job or sub-account id, and one that is not terminal", async () => {
    expect(await (await signed({ formResponseId: undefined })).json()).toEqual({ ok: true, ignored: "missing-ids" });
    expect(await (await signed({ subAccountId: 7 })).json()).toEqual({ ok: true, ignored: "missing-ids" });
    expect(await (await signed({ status: "processing", pagesUrl: null })).json()).toEqual({
      ok: true,
      ignored: "not-terminal",
    });
    expect(mem.read(SITE)).toMatchObject(untouched);
  });
});
