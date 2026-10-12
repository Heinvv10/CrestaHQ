import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { NonPublicUrlError } from "@/lib/webhooks/validate-url";
import type { PublicFetchInit } from "@/lib/webhooks/public-fetch";

/**
 * resolveLiveUrl follows the redirects on the address gitpage reports — an
 * address that is not ours. So it never lets anything follow a redirect on
 * its own: one `publicFetch` per hop, each `Location` checked before it is
 * requested, one deadline for the whole walk, and the reported address back
 * on anything it does not like. `publicFetch` is the seam here; that it is
 * the guarded fetch is proven against a real loopback server in
 * lib/webhooks/ssrf-callers.test.ts.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const publicFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch }));

const { isPlausibleSiteUrl, resolveLiveUrl } = await import("./website-handoff-service");

const REPORTED = "https://acme.gitlab.io/site";
const redirect = (location: string | null, status = 308) =>
  new Response(null, { status, headers: location === null ? {} : { location } });
const page = (status = 200) => new Response(null, { status });

/** Answer each URL from a table; anything else is a test bug. */
function serve(routes: Record<string, () => Response>) {
  publicFetch.mockImplementation(async (url: string) => {
    const answer = routes[url];
    if (!answer) throw new Error(`unexpected fetch of ${url}`);
    return answer();
  });
}
const fetched = () => publicFetch.mock.calls.map((c) => c[0] as string);
/** Where the walk ended; `resolveLiveUrl(...).resolved` is asserted separately. */
const resolve = async (url: string) => (await resolveLiveUrl(url)).url;

beforeEach(() => {
  // A block, not an expression: mockReset returns the mock, and a function
  // returned from beforeEach is run as a teardown.
  publicFetch.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveLiveUrl", () => {
  it("returns the reported URL when it does not redirect", async () => {
    serve({ [REPORTED]: () => page() });
    expect(await resolve(REPORTED)).toBe(REPORTED);
    expect(fetched()).toEqual([REPORTED]);
  });

  it("follows a chain of redirects to where the site really lives, one guarded request per hop", async () => {
    serve({
      [REPORTED]: () => redirect("https://acme-site-1a2b3c.gitlab.io/"),
      "https://acme-site-1a2b3c.gitlab.io/": () => redirect("https://www.acme-site-1a2b3c.gitlab.io/", 301),
      "https://www.acme-site-1a2b3c.gitlab.io/": () => page(),
    });
    expect(await resolve(REPORTED)).toBe("https://www.acme-site-1a2b3c.gitlab.io/");
    expect(fetched()).toEqual([REPORTED, "https://acme-site-1a2b3c.gitlab.io/", "https://www.acme-site-1a2b3c.gitlab.io/"]);
    // Nothing is left to follow a redirect by itself, and no body is wanted.
    for (const [, init] of publicFetch.mock.calls as Array<[string, PublicFetchInit]>) {
      expect(init.method).toBe("HEAD");
      expect(init.maxBytes).toBeLessThanOrEqual(64 * 1024);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([301, 302, 303, 307, 308])("treats %i as a redirect", async (status) => {
    serve({
      [REPORTED]: () => redirect("https://acme-site-1a2b3c.gitlab.io/", status),
      "https://acme-site-1a2b3c.gitlab.io/": () => page(),
    });
    expect(await resolve(REPORTED)).toBe("https://acme-site-1a2b3c.gitlab.io/");
  });

  it("resolves a relative Location against the hop it came from, not the first URL", async () => {
    serve({
      [REPORTED]: () => redirect("https://acme-site-1a2b3c.gitlab.io/a/b"),
      "https://acme-site-1a2b3c.gitlab.io/a/b": () => redirect("../home/"),
      "https://acme-site-1a2b3c.gitlab.io/home/": () => page(),
    });
    expect(await resolve(REPORTED)).toBe("https://acme-site-1a2b3c.gitlab.io/home/");
  });

  it("where the walk lands is the answer whatever that page's status", async () => {
    serve({
      [REPORTED]: () => redirect("https://acme-site-1a2b3c.gitlab.io/"),
      "https://acme-site-1a2b3c.gitlab.io/": () => page(404),
    });
    expect(await resolve(REPORTED)).toBe("https://acme-site-1a2b3c.gitlab.io/");
  });

  it("gives up on a redirect loop and returns the reported URL", async () => {
    serve({
      [REPORTED]: () => redirect("https://b.gitlab.io/"),
      "https://b.gitlab.io/": () => redirect(REPORTED),
    });
    expect(await resolve(REPORTED)).toBe(REPORTED);
    expect(publicFetch).toHaveBeenCalledTimes(5);
  });

  it("makes at most five requests: a fifth redirect is not followed", async () => {
    const hop = (n: number) => `https://hop${n}.gitlab.io/`;
    serve({
      [REPORTED]: () => redirect(hop(1)),
      [hop(1)]: () => redirect(hop(2)),
      [hop(2)]: () => redirect(hop(3)),
      [hop(3)]: () => redirect(hop(4)),
      [hop(4)]: () => redirect(hop(5)),
      [hop(5)]: () => page(),
    });
    expect(await resolve(REPORTED)).toBe(REPORTED);
    expect(fetched()).toEqual([REPORTED, hop(1), hop(2), hop(3), hop(4)]);
  });

  it("follows four redirects, the most the cap allows", async () => {
    const hop = (n: number) => `https://hop${n}.gitlab.io/`;
    serve({
      [REPORTED]: () => redirect(hop(1)),
      [hop(1)]: () => redirect(hop(2)),
      [hop(2)]: () => redirect(hop(3)),
      [hop(3)]: () => redirect(hop(4)),
      [hop(4)]: () => page(),
    });
    expect(await resolve(REPORTED)).toBe(hop(4));
  });

  it("says whether it landed: resolved on an answer that is not a redirect, unresolved on giving up", async () => {
    serve({
      [REPORTED]: () => redirect("https://acme-site-1a2b3c.gitlab.io/"),
      "https://acme-site-1a2b3c.gitlab.io/": () => page(),
    });
    expect(await resolveLiveUrl(REPORTED)).toEqual({ url: "https://acme-site-1a2b3c.gitlab.io/", resolved: true });
    serve({ [REPORTED]: () => page() });
    expect(await resolveLiveUrl(REPORTED)).toEqual({ url: REPORTED, resolved: true });
    serve({ [REPORTED]: () => redirect(null) });
    expect(await resolveLiveUrl(REPORTED)).toEqual({ url: REPORTED, resolved: false });
  });

  it.each([
    ["a third-party host", "https://attacker.example/"],
    ["a public IP literal", "https://8.8.8.8/"],
    ["a look-alike that only ends in the parent's name", "https://evilgitlab.io/"],
    ["the parent domain's own sibling TLD trick", "https://gitlab.io.attacker.example/"],
  ])("a hop to %s, outside the reported host's domain, is refused before it is requested", async (_label, location) => {
    serve({ [REPORTED]: () => redirect(location) });
    expect(await resolveLiveUrl(REPORTED)).toEqual({ url: REPORTED, resolved: false });
    expect(fetched()).toEqual([REPORTED]);
  });

  it("a two-label reported host keeps its family to itself and its subdomains, never the whole TLD", async () => {
    const reported = "https://acme.example/site";
    serve({ [reported]: () => redirect("https://other.example/") });
    expect(await resolveLiveUrl(reported)).toEqual({ url: reported, resolved: false });
    serve({
      [reported]: () => redirect("https://www.acme.example/"),
      "https://www.acme.example/": () => page(),
    });
    expect(await resolveLiveUrl(reported)).toEqual({ url: "https://www.acme.example/", resolved: true });
  });

  it.each([
    ["a public-suffix sibling (acme.co.za → evil.co.za)", "https://acme.co.za/", "https://evil.co.za/"],
    ["a trailing-dot two-label host (acme.com. → attacker.com.)", "https://acme.com./", "https://attacker.com./"],
    ["a trailing-dot report to a sibling without the dot", "https://acme.com./", "https://attacker.com/"],
    ["a custom domain's registrable sibling under the same suffix", "https://www.acme.co.za/", "https://www.evil.co.za/"],
  ])("refuses %s before it is requested", async (_label, reported, location) => {
    serve({ [reported]: () => redirect(location) });
    expect(await resolveLiveUrl(reported)).toEqual({ url: reported, resolved: false });
    expect(fetched()).toEqual([reported]);
  });

  it.each([
    ["apex → www on a .co.za domain", "https://acme.co.za/", "https://www.acme.co.za/"],
    ["www → apex on a .co.za domain", "https://www.acme.co.za/", "https://acme.co.za/"],
    ["www → apex on a .com domain", "https://www.acme.com/", "https://acme.com/"],
    ["a trailing-dot report to its own www", "https://acme.com./", "https://www.acme.com/"],
    ["a GitHub Pages path URL to another *.github.io host", "https://gitpage-ns.github.io/acme", "https://acme-site.github.io/"],
  ])("follows %s and lands there", async (_label, reported, location) => {
    serve({ [reported]: () => redirect(location), [location]: () => page() });
    expect(await resolveLiveUrl(reported)).toEqual({ url: location, resolved: true });
  });

  it("www → apex is a twin only: a different subdomain of the apex is not reachable from www", async () => {
    serve({ ["https://www.acme.co.za/"]: () => redirect("https://shop.acme.co.za/") });
    expect(await resolveLiveUrl("https://www.acme.co.za/")).toEqual({ url: "https://www.acme.co.za/", resolved: false });
  });

  it("returns the reported URL for a redirect with no Location", async () => {
    serve({ [REPORTED]: () => redirect(null) });
    expect(await resolve(REPORTED)).toBe(REPORTED);
    expect(publicFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a loopback literal", "https://127.0.0.1/"],
    ["a private-range literal", "https://10.0.0.5/admin"],
    ["the cloud metadata address", "https://169.254.169.254/latest/meta-data/"],
    ["a CGNAT (Tailscale) literal", "https://100.96.203.105/"],
    ["an IPv6 loopback literal", "https://[::1]/"],
    ["localhost", "https://localhost/"],
    ["plain http", "http://acme-site-1a2b3c.gitlab.io/"],
    ["credentials in the URL", "https://user:pass@acme-site-1a2b3c.gitlab.io/"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,<script>alert(1)</script>"],
    ["a file: URL", "file:///etc/passwd"],
    ["an over-long URL", `https://acme-site-1a2b3c.gitlab.io/${"a".repeat(2100)}`],
    ["GitLab's sign-in page", "https://gitlab.com/users/sign_in"],
    ["the GitLab Pages access-control host", "https://projects.gitlab.io/auth?domain=https://acme.gitlab.io"],
    ["something that is not a URL", "https://exa mple.com:99999/"],
  ])("a hop to %s is refused BEFORE it is requested: the reported URL comes back", async (_label, location) => {
    serve({ [REPORTED]: () => redirect(location) });
    expect(await resolve(REPORTED)).toBe(REPORTED);
    // Only the first request went out; the hostile hop was never fetched.
    expect(fetched()).toEqual([REPORTED]);
  });

  it("a later hop whose NAME resolves to a private address is refused by the guarded fetch", async () => {
    publicFetch.mockImplementation(async (url: string) => {
      if (url === REPORTED) return redirect("https://rebind.gitlab.io/");
      throw new NonPublicUrlError("rebind.gitlab.io");
    });
    expect(await resolve(REPORTED)).toBe(REPORTED);
    // It went through publicFetch — the only thing that can refuse it.
    expect(fetched()).toEqual([REPORTED, "https://rebind.gitlab.io/"]);
  });

  it("shares ONE 3s deadline across every hop", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    serve({
      [REPORTED]: () => redirect("https://hop1.gitlab.io/"),
      "https://hop1.gitlab.io/": () => redirect("https://hop2.gitlab.io/"),
      "https://hop2.gitlab.io/": () => page(),
    });
    expect(await resolve(REPORTED)).toBe("https://hop2.gitlab.io/");
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(3000);
    expect(publicFetch).toHaveBeenCalledTimes(3);
    for (const [, init] of publicFetch.mock.calls as Array<[string, PublicFetchInit]>) {
      expect(init.signal).toBe(deadline.signal);
    }
  });

  it("the deadline running out part-way through the walk ends it: the reported URL, no further hops", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    publicFetch.mockImplementation(async (url: string, init: PublicFetchInit) => {
      if (url === REPORTED) return redirect("https://slow.gitlab.io/");
      // The second hop hangs until the shared deadline fires.
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
      });
    });
    expect(await resolve(REPORTED)).toBe(REPORTED);
    expect(fetched()).toEqual([REPORTED, "https://slow.gitlab.io/"]);
  });

  it.each([
    ["a network error", new Error("ECONNRESET")],
    ["a refused address", new NonPublicUrlError("acme.gitlab.io")],
    ["a non-Error throw", "boom"],
  ])("never throws: %s on the first request returns the reported URL", async (_label, thrown) => {
    publicFetch.mockRejectedValue(thrown);
    await expect(resolveLiveUrl(REPORTED)).resolves.toEqual({ url: REPORTED, resolved: false });
  });

  it.each([
    ["GitLab's sign-in page", "https://gitlab.com/users/sign_in"],
    ["a plain-http address", "http://acme.gitlab.io/site"],
    ["not a URL", "not a url"],
  ])("does not request a reported URL that is %s, and returns it unchanged", async (_label, url) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await resolve(url)).toBe(url);
    expect(publicFetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("isPlausibleSiteUrl", () => {
  it("accepts an https site address", () => {
    expect(isPlausibleSiteUrl("https://acme-site-1a2b3c.gitlab.io/")).toBe(true);
    expect(isPlausibleSiteUrl("https://www.acme-site-1a2b3c.gitlab.io/users/sign_in_help")).toBe(true);
  });

  it("refuses git hosts' own pages, sign-in pages and anything not https", () => {
    for (const url of [
      "https://gitlab.com/acme/site",
      "https://www.github.com/acme/site",
      "https://projects.gitlab.io/auth",
      "https://acme.example/users/sign_in",
      "http://acme.example/",
      "nope",
    ]) {
      expect(isPlausibleSiteUrl(url), url).toBe(false);
    }
  });
});
