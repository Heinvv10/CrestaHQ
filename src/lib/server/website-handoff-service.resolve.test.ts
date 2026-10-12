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
    expect(await resolveLiveUrl(REPORTED)).toBe(REPORTED);
    expect(fetched()).toEqual([REPORTED]);
  });

  it("follows a chain of redirects to where the site really lives, one guarded request per hop", async () => {
    serve({
      [REPORTED]: () => redirect("https://acme-site-1a2b3c.gitlab.io/"),
      "https://acme-site-1a2b3c.gitlab.io/": () => redirect("https://www.acme.example/", 301),
      "https://www.acme.example/": () => page(),
    });
    expect(await resolveLiveUrl(REPORTED)).toBe("https://www.acme.example/");
    expect(fetched()).toEqual([REPORTED, "https://acme-site-1a2b3c.gitlab.io/", "https://www.acme.example/"]);
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
    expect(await resolveLiveUrl(REPORTED)).toBe("https://acme-site-1a2b3c.gitlab.io/");
  });

  it("resolves a relative Location against the hop it came from, not the first URL", async () => {
    serve({
      [REPORTED]: () => redirect("https://acme-site-1a2b3c.gitlab.io/a/b"),
      "https://acme-site-1a2b3c.gitlab.io/a/b": () => redirect("../home/"),
      "https://acme-site-1a2b3c.gitlab.io/home/": () => page(),
    });
    expect(await resolveLiveUrl(REPORTED)).toBe("https://acme-site-1a2b3c.gitlab.io/home/");
  });

  it("where the walk lands is the answer whatever that page's status", async () => {
    serve({
      [REPORTED]: () => redirect("https://acme-site-1a2b3c.gitlab.io/"),
      "https://acme-site-1a2b3c.gitlab.io/": () => page(404),
    });
    expect(await resolveLiveUrl(REPORTED)).toBe("https://acme-site-1a2b3c.gitlab.io/");
  });

  it("gives up on a redirect loop and returns the reported URL", async () => {
    serve({
      [REPORTED]: () => redirect("https://b.example/"),
      "https://b.example/": () => redirect(REPORTED),
    });
    expect(await resolveLiveUrl(REPORTED)).toBe(REPORTED);
    expect(publicFetch).toHaveBeenCalledTimes(5);
  });

  it("makes at most five requests: a fifth redirect is not followed", async () => {
    const hop = (n: number) => `https://hop${n}.example/`;
    serve({
      [REPORTED]: () => redirect(hop(1)),
      [hop(1)]: () => redirect(hop(2)),
      [hop(2)]: () => redirect(hop(3)),
      [hop(3)]: () => redirect(hop(4)),
      [hop(4)]: () => redirect(hop(5)),
      [hop(5)]: () => page(),
    });
    expect(await resolveLiveUrl(REPORTED)).toBe(REPORTED);
    expect(fetched()).toEqual([REPORTED, hop(1), hop(2), hop(3), hop(4)]);
  });

  it("follows four redirects, the most the cap allows", async () => {
    const hop = (n: number) => `https://hop${n}.example/`;
    serve({
      [REPORTED]: () => redirect(hop(1)),
      [hop(1)]: () => redirect(hop(2)),
      [hop(2)]: () => redirect(hop(3)),
      [hop(3)]: () => redirect(hop(4)),
      [hop(4)]: () => page(),
    });
    expect(await resolveLiveUrl(REPORTED)).toBe(hop(4));
  });

  it("returns the reported URL for a redirect with no Location", async () => {
    serve({ [REPORTED]: () => redirect(null) });
    expect(await resolveLiveUrl(REPORTED)).toBe(REPORTED);
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
    expect(await resolveLiveUrl(REPORTED)).toBe(REPORTED);
    // Only the first request went out; the hostile hop was never fetched.
    expect(fetched()).toEqual([REPORTED]);
  });

  it("a later hop whose NAME resolves to a private address is refused by the guarded fetch", async () => {
    publicFetch.mockImplementation(async (url: string) => {
      if (url === REPORTED) return redirect("https://rebind.example/");
      throw new NonPublicUrlError("rebind.example");
    });
    expect(await resolveLiveUrl(REPORTED)).toBe(REPORTED);
    // It went through publicFetch — the only thing that can refuse it.
    expect(fetched()).toEqual([REPORTED, "https://rebind.example/"]);
  });

  it("shares ONE 3s deadline across every hop", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    serve({
      [REPORTED]: () => redirect("https://hop1.example/"),
      "https://hop1.example/": () => redirect("https://hop2.example/"),
      "https://hop2.example/": () => page(),
    });
    expect(await resolveLiveUrl(REPORTED)).toBe("https://hop2.example/");
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
      if (url === REPORTED) return redirect("https://slow.example/");
      // The second hop hangs until the shared deadline fires.
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
      });
    });
    expect(await resolveLiveUrl(REPORTED)).toBe(REPORTED);
    expect(fetched()).toEqual([REPORTED, "https://slow.example/"]);
  });

  it.each([
    ["a network error", new Error("ECONNRESET")],
    ["a refused address", new NonPublicUrlError("acme.gitlab.io")],
    ["a non-Error throw", "boom"],
  ])("never throws: %s on the first request returns the reported URL", async (_label, thrown) => {
    publicFetch.mockRejectedValue(thrown);
    await expect(resolveLiveUrl(REPORTED)).resolves.toBe(REPORTED);
  });

  it.each([
    ["GitLab's sign-in page", "https://gitlab.com/users/sign_in"],
    ["a plain-http address", "http://acme.gitlab.io/site"],
    ["not a URL", "not a url"],
  ])("does not request a reported URL that is %s, and returns it unchanged", async (_label, url) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await resolveLiveUrl(url)).toBe(url);
    expect(publicFetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("isPlausibleSiteUrl", () => {
  it("accepts an https site address", () => {
    expect(isPlausibleSiteUrl("https://acme-site-1a2b3c.gitlab.io/")).toBe(true);
    expect(isPlausibleSiteUrl("https://www.acme.example/users/sign_in_help")).toBe(true);
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
