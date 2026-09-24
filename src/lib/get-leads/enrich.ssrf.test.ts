import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetLeadsBusiness } from "@/types/get-leads";

/**
 * A business's website is owner-controlled text Google hands back. The
 * homepage fetch runs through the real publicFetch here (no mock), against a
 * loopback server standing in for an internal service: in production nothing
 * may reach it — by literal, by a name resolving there, or via a redirect
 * from a public-looking site.
 */

const dns = new Map<string, string>();
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    const address = dns.get(host);
    if (!address) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return [{ address, family: 4 }];
  }),
}));

// Only the first hop of the redirect case is faked (a public site answering
// 302 → internal); every other call goes through the real publicFetch.
vi.mock("@/lib/webhooks/public-fetch", async (orig) => {
  const real = await orig<typeof import("@/lib/webhooks/public-fetch")>();
  return {
    publicFetch: vi.fn(async (url: string, init?: Parameters<typeof real.publicFetch>[1]) =>
      url.startsWith("https://public-redirector.example")
        ? new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${port}/internal` } })
        : real.publicFetch(url, init),
    ),
  };
});

const { enrichBusinesses } = await import("./enrich");

let hits: string[] = [];
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<a href="mailto:secret@internal.example">x</a>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  hits = [];
  dns.clear();
});
afterEach(() => vi.unstubAllEnvs());

function biz(website: string): GetLeadsBusiness {
  return {
    placeId: "p",
    googlePlaceId: "p",
    name: "Invented",
    category: null,
    fullAddress: null,
    city: null,
    phone: null,
    website,
    email: null,
    facebook: null,
    instagram: null,
    rating: null,
    reviewsCount: null,
    latitude: null,
    longitude: null,
  };
}

describe("homepage enrichment SSRF guard (production)", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "production"));

  it("refuses a private literal, a name resolving to loopback, and a redirect into loopback", async () => {
    dns.set("looks-public.example", "127.0.0.1");
    const out = await enrichBusinesses([
      biz(`http://127.0.0.1:${port}/`),
      biz(`http://looks-public.example:${port}/`),
      biz("https://public-redirector.example/"),
    ]);
    expect(out.map((b) => b.email)).toEqual([null, null, null]);
    expect(hits).toEqual([]);
  });
});

describe("control: the same fetch reaches loopback when the guard is off (dev)", () => {
  it("proves the server above is reachable, so the empty hits are the guard's doing", async () => {
    const [b] = await enrichBusinesses([biz(`http://127.0.0.1:${port}/`)]);
    expect(b!.email).toBe("secret@internal.example");
    expect(hits).toEqual(["/"]);
  });
});
