import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY, SIMPLE_FIELDS, form, html, loopbackFetch, ports, serve, skipBrowser, type Fixture, type Handler,
} from "@/test/form-fixture-server";
import { LAUNCH_ARGS, launchFormBrowser } from "./browser";
import { runFormFill } from "./engine";
import { MAX_TOTAL_BYTES } from "./network";

/**
 * The 5c breaker's resource and timing attacks (review round 1): the job's
 * request / byte budget (V2), ports (V4), frames it cannot look into (V3),
 * speculation-rules prefetch outside the route (V9) and the deadline racing
 * the submit stamp.
 */

let site: Fixture;
let internal: Fixture;
beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.spyOn(console, "error").mockImplementation(() => {});
  internal = await serve({ "/": (_q, res) => html(res, "internal") });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await site?.close();
  await internal.close();
});

const ok: Handler = (_q, res) => html(res, "<h1>Thank you</h1>");
const T = 60_000;
const fill = (over: Partial<Parameters<typeof runFormFill>[0]> = {}) =>
  runFormFill({
    url: `${site.origin}/contact`, identity: IDENTITY, fetchImpl: loopbackFetch(site.origin), allowPorts: ports(site.origin),
    limits: { totalMs: 15_000, settleMs: 1_500, confirmMs: 2_000 }, ...over,
  });

describe.skipIf(skipBrowser)("the job's budget", () => {
  it("60 parallel 4.9 MB fetches: the bytes stop at the budget and the form still goes", async () => {
    const big = Buffer.alloc(4_900_000, 97);
    site = await serve({
      "/contact": (_q, res) =>
        html(res, form(SIMPLE_FIELDS) + `<script>for (let k=0;k<60;k++) fetch("/big?"+k).then(r=>r.text()).catch(()=>{});</script>`),
      "/big": (_q, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(big);
      },
      "/send": ok,
    });
    const out = await fill({ limits: { totalMs: 30_000, settleMs: 3_000, confirmMs: 2_000 } });
    const served = site.hits.filter((h) => h.includes("/big")).length;
    expect(served * big.length).toBeLessThanOrEqual(MAX_TOTAL_BYTES + 6 * big.length);
    expect(served).toBeLessThan(60);
    expect(out.kind).not.toBe("failed");
  }, T);

  it("a page whose own document is over the budget is too heavy (nothing submitted, refunded)", async () => {
    site = await serve({
      "/contact": (_q, res) =>
        html(res, form(SIMPLE_FIELDS) + `<script>if (!location.search) Promise.all(Array.from({ length: 200 }, (_, k) => fetch("/x?"+k).catch(()=>{}))).then(() => { location.href = "/contact?again"; });</script>`),
      "/x": (_q, res) => html(res, "x"),
    });
    const out = await fill({ limits: { totalMs: 25_000, settleMs: 6_000, confirmMs: 2_000 } });
    expect(site.hits.filter((h) => h.startsWith("GET /x")).length).toBeLessThanOrEqual(150);
    expect(out).toMatchObject({ kind: "failed", code: "page_too_heavy" });
  }, T);

  it("at most 6 requests in flight at once; the rest wait", async () => {
    let now = 0;
    let peak = 0;
    site = await serve({
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + `<script>for (let k=0;k<20;k++) fetch("/slow?"+k).catch(()=>{});</script>`),
      "/slow": (_q, res) => {
        peak = Math.max(peak, ++now);
        setTimeout(() => {
          now--;
          html(res, "x");
        }, 300);
      },
      "/send": ok,
    });
    await fill({ limits: { totalMs: 20_000, settleMs: 3_000, confirmMs: 2_000 } });
    expect(site.hits.filter((h) => h.includes("/slow")).length).toBeGreaterThan(6);
    expect(peak).toBeLessThanOrEqual(6);
  }, T);
});

describe.skipIf(skipBrowser)("ports", () => {
  it("only 80 / 443: a page's requests to other ports never reach the fetcher", async () => {
    site = await serve({
      "/contact": (_q, res) =>
        html(res, form(SIMPLE_FIELDS) + `<script>for (const p of [25, 587, 110, 6000, 6667, 5432, 6379]) fetch("http://203.0.113.9:"+p+"/x", {method:"POST", mode:"no-cors", body:"HELO"}).catch(()=>{});</script>`),
      "/send": ok,
    });
    const seen: string[] = [];
    const inner = loopbackFetch(site.origin);
    await fill({
      fetchImpl: async (url, init) => {
        if (url.startsWith(site.origin)) return inner(url, init);
        seen.push(url);
        throw new Error("not contacted");
      },
    });
    expect(seen).toEqual([]);
  }, T);

  it("a redirect to another port — of the page or of a script — is never followed", async () => {
    site = await serve({ "/contact": (_q, res) => html(res, "", 302, { location: `${internal.origin}/` }) });
    expect(await fill()).toMatchObject({ kind: "refused", code: "ssrf_blocked" });
    await site.close();
    site = await serve({
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + `<script src="/lib.js"></script>`),
      "/lib.js": (_q, res) => html(res, "", 302, { location: `${internal.origin.replace("127.0.0.1", "203.0.113.9")}/lib.js` }),
      "/send": ok,
    });
    const seen: string[] = [];
    const inner = loopbackFetch(site.origin);
    await fill({
      fetchImpl: async (url, init) => {
        if (url.startsWith(site.origin)) return inner(url, init);
        seen.push(url);
        throw new Error("not contacted");
      },
    });
    expect(seen).toEqual([]);
    expect(internal.hits).toEqual([]);
  }, T);

  it("a form page on another port is refused", async () => {
    site = await serve({ "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS)) });
    expect(await fill({ allowPorts: [] })).toMatchObject({ kind: "refused", code: "ssrf_blocked" });
    expect(site.hits).toEqual([]);
  }, T);
});

describe.skipIf(skipBrowser)("frames it cannot look into", () => {
  it.each([
    ["file:", `<iframe src="file:///etc/passwd"></iframe>`],
    ["view-source:", `<iframe src="view-source:https://example.com/"></iframe>`],
    ["chrome:", `<iframe src="chrome://version"></iframe>`],
    ["a frame stuck in a loop", `<iframe srcdoc="<script>setTimeout(() => { while(true){} }, 50)</script>"></iframe>`],
  ])("%s: refused uninspectable_frame before typing, never hung", async (_name, frame) => {
    site = await serve({ "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + frame), "/send": ok });
    const t0 = Date.now();
    const out = await fill({ limits: { totalMs: 10_000, settleMs: 500, confirmMs: 2_000 } });
    expect(Date.now() - t0).toBeLessThan(25_000);
    expect(out).toMatchObject({ kind: "refused", code: "uninspectable_frame" });
    expect(site.posts).toEqual([]);
  }, T);
});

describe.skipIf(skipBrowser)("speculation rules", () => {
  it("prefetch / prerender never escape the route, even WITHOUT the dead proxy", async () => {
    const i = internal.origin;
    site = await serve({
      "/contact": (_q, res) =>
        html(res, form(SIMPLE_FIELDS) + `<script type="speculationrules">{"prefetch":[{"source":"list","urls":["${i}/specprefetch"]}],"prerender":[{"source":"list","urls":["${i}/specprerender"]}]}</script>`),
      "/send": ok,
    });
    await fill({ launch: () => launchFormBrowser(LAUNCH_ARGS.filter((a) => !a.includes("proxy"))), limits: { totalMs: 15_000, settleMs: 3_000, confirmMs: 2_000 } });
    expect(internal.hits).toEqual([]);
  }, T);
});

describe.skipIf(skipBrowser)("the deadline and the submit stamp", () => {
  it.each([25, 60, 200])("a stamp that lands %ims after the deadline never leads to a click", async (lateMs) => {
    site = await serve({ "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS)), "/send": ok });
    const totalMs = 6_000;
    const t0 = Date.now();
    const out = await fill({
      limits: { totalMs, settleMs: 300, confirmMs: 3_000 },
      onBeforeSubmit: () => new Promise((r) => setTimeout(r, Math.max(0, totalMs - (Date.now() - t0)) + lateMs)),
      // A loaded box: closing Chromium takes a while, so the page is still alive when the stamp lands.
      launch: async () => {
        const b = await launchFormBrowser();
        return { context: b.context, close: () => new Promise<void>((r) => setTimeout(r, 1_500)).then(b.close) };
      },
    });
    await new Promise((r) => setTimeout(r, 1_000));
    expect(out).toMatchObject({ kind: "failed", code: "timeout" });
    expect(site.posts).toEqual([]);
  }, T);
});
