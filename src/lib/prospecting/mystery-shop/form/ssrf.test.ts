import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY, SIMPLE_FIELDS, form, html, loopbackFetch, ports, serve, skipBrowser, type Fixture,
} from "@/test/form-fixture-server";
import { launchFormBrowser } from "./browser";
import { runFormFill } from "./engine";
import { defaultFetch } from "./network";

/**
 * The browser never reaches a private address. `internal` stands for
 * something on the box's network: a second server on 127.0.0.1 the engine is
 * NOT allowed to reach. Every refusal is proven both ways: the result says
 * so, and `internal` saw no request at all. The real publicFetch decides
 * (NODE_ENV=production, as on velo).
 */

let site: Fixture;
let internal: Fixture;
beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.spyOn(console, "error").mockImplementation(() => {});
  internal = await serve({ "/": (_q, res) => html(res, form(SIMPLE_FIELDS)) });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await site?.close();
  await internal.close();
});

const limits = { settleMs: 300, confirmMs: 2_000 };

describe.skipIf(skipBrowser)("SSRF: the form URL itself", () => {
  it.each([
    ["loopback", () => `${internal.origin}/`],
    ["the cloud metadata address", () => "http://169.254.169.254/latest/meta-data/"],
    ["a private network address", () => "http://10.255.255.1/contact"],
    ["IPv6 loopback", () => "http://[::1]/"],
  ])("%s is refused by the real publicFetch", async (_name, url) => {
    // The internal port is allowed here, so it is the address check that refuses (the port rule is tested apart).
    const out = await runFormFill({ url: url(), identity: IDENTITY, fetchImpl: defaultFetch, limits, allowPorts: ports(internal.origin) });
    expect(out).toMatchObject({ kind: "refused", code: "ssrf_blocked" });
    expect(internal.hits).toEqual([]);
  });
});

describe.skipIf(skipBrowser)("SSRF: a public page leading somewhere private", () => {
  const run = async (routes: Parameters<typeof serve>[0]) => {
    site = await serve(routes);
    return runFormFill({
      url: `${site.origin}/contact`, identity: IDENTITY, fetchImpl: loopbackFetch(site.origin), limits,
      allowPorts: ports(site.origin, internal.origin),
    });
  };

  it("a redirect to a private host", async () => {
    const out = await run({ "/contact": (_q, res) => html(res, "", 302, { location: `${internal.origin}/` }) });
    expect(out).toMatchObject({ kind: "refused", code: "ssrf_blocked" });
    expect(internal.hits).toEqual([]);
  });

  it("a redirect to the metadata address", async () => {
    const out = await run({ "/contact": (_q, res) => html(res, "", 301, { location: "http://169.254.169.254/" }) });
    expect(out).toMatchObject({ kind: "refused", code: "ssrf_blocked" });
  });

  it("scripts, styles, frames, images, fetches, beacons and WebSockets to a private host never arrive", async () => {
    const i = internal.origin;
    const out = await run({
      "/contact": (_q, res) =>
        html(res, form(SIMPLE_FIELDS) + `<script src="${i}/s.js"></script><link rel="stylesheet" href="${i}/c.css">
          <img src="${i}/i.png"><iframe src="${i}/f"></iframe><link rel="preconnect" href="${i}">
          <script>fetch("${i}/x").catch(() => {}); navigator.sendBeacon("${i}/b", "x");
          try { new WebSocket("${i.replace("http", "ws")}/ws"); } catch (e) {}
          new EventSource("${i}/e"); const r = new XMLHttpRequest(); r.open("GET", "${i}/xhr"); r.send();</script>`),
      "/send": (_q, res) => html(res, "<h1>Thank you</h1>"),
    });
    expect(out).toMatchObject({ kind: "sent" });
    expect(internal.hits).toEqual([]);
  });

  it("a sub-resource redirecting to a private host", async () => {
    const out = await run({
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + `<script src="/lib.js"></script>`),
      "/lib.js": (_q, res) => html(res, "", 302, { location: `${internal.origin}/lib.js` }),
      "/send": (_q, res) => html(res, "<h1>Thank you</h1>"),
    });
    expect(out).toMatchObject({ kind: "sent" });
    expect(internal.hits).toEqual([]);
  });

  it("a form posting to a private host", async () => {
    const out = await run({ "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS, `method="post" action="${internal.origin}/"`)) });
    expect(out).toMatchObject({ kind: "refused", code: "ssrf_blocked" });
    expect(internal.hits).toEqual([]);
  });
});

describe.skipIf(skipBrowser)("the launch backstop", () => {
  it("with no route at all, Chromium still cannot reach the network (dead proxy, loopback included)", async () => {
    const browser = await launchFormBrowser();
    try {
      const page = await browser.context.newPage();
      await expect(page.goto(`${internal.origin}/`, { timeout: 10_000 })).rejects.toThrow(/ERR_PROXY_CONNECTION_FAILED|ERR_/);
    } finally {
      await browser.close();
    }
    expect(internal.hits).toEqual([]);
  });
});
