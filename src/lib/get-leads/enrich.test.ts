import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GetLeadsBusiness } from "@/types/get-leads";

const publicFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch }));

const { extractContacts, enrichBusinesses, ENRICH_CONCURRENCY, HOMEPAGE_MAX_BYTES } =
  await import("./enrich");

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
}

function biz(i: number, website: string | null): GetLeadsBusiness {
  return {
    placeId: `p${i}`,
    googlePlaceId: `p${i}`,
    name: `Invented ${i}`,
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

const FIXTURE_HTML = `
<html><head>
  <link rel="icon" href="/logo@2x.png">
  <script src="https://browser.sentry-cdn.example/x.js" data-dsn="abc123@o0.ingest.sentry.io"></script>
</head><body>
  <a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>
  <a href="https://www.facebook.com/FixturePlumbing/">Facebook</a>
  <a href="https://instagram.com/p/AbCdEf/">A post</a>
  <a href="https://www.instagram.com/fixture.plumbing?igsh=1">Instagram</a>
  <p>Built by webmaster@some-agency.example</p>
  <a href="mailto:Hello%40Fixture-Plumbing.example?subject=Quote">Email us</a>
</body></html>`;

describe("extractContacts", () => {
  it("prefers an email on the site's own domain and picks profile links, not share/post links", () => {
    expect(extractContacts(FIXTURE_HTML, "https://www.fixture-plumbing.example/")).toEqual({
      email: "hello@fixture-plumbing.example",
      facebook: "https://www.facebook.com/FixturePlumbing",
      instagram: "https://www.instagram.com/fixture.plumbing",
    });
  });

  it("falls back to the first plausible off-domain email and ignores asset/sentry lookalikes", () => {
    const page = `<img src="hero@2x.webp"> abc@o0.ingest.sentry.io <p>office@gmail.example</p>`;
    expect(extractContacts(page, "https://other.example").email).toBe("office@gmail.example");
  });

  it("returns nulls for a page with nothing on it", () => {
    expect(extractContacts("<html></html>", "https://x.example")).toEqual({
      email: null,
      facebook: null,
      instagram: null,
    });
  });
});

describe("enrichBusinesses", () => {
  beforeEach(() => {
    publicFetch.mockReset();
  });

  it("fills email + socials from the homepage and leaves rows without a website alone", async () => {
    publicFetch.mockResolvedValue(html(FIXTURE_HTML));
    const [a, b] = await enrichBusinesses([
      biz(1, "https://www.fixture-plumbing.example/"),
      biz(2, null),
    ]);
    expect(a).toMatchObject({
      email: "hello@fixture-plumbing.example",
      facebook: "https://www.facebook.com/FixturePlumbing",
      instagram: "https://www.instagram.com/fixture.plumbing",
    });
    expect(b).toEqual(biz(2, null));
    expect(publicFetch).toHaveBeenCalledTimes(1);
    const [, init] = publicFetch.mock.calls[0]!;
    expect(init.maxBytes).toBe(HOMEPAGE_MAX_BYTES);
    expect(HOMEPAGE_MAX_BYTES).toBeLessThanOrEqual(500 * 1024);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers["User-Agent"]).toMatch(/LeadStack/);
  });

  it("a failing or refused site only costs that row its email", async () => {
    publicFetch.mockImplementation(async (url: string) => {
      if (url.includes("broken")) throw new Error("Refused: 10.0.0.1 is not a public internet address.");
      if (url.includes("500")) return html("oops", 500);
      return html(`<a href="mailto:hi@ok.example">x</a>`);
    });
    const out = await enrichBusinesses([
      biz(1, "https://broken.example"),
      biz(2, "https://ok.example"),
      biz(3, "https://500.example"),
    ]);
    expect(out.map((b) => b.email)).toEqual([null, "hi@ok.example", null]);
  });

  it("follows at most 3 redirects, resolving relative Locations", async () => {
    publicFetch
      .mockResolvedValueOnce(html("", 301, { location: "/home" }))
      .mockResolvedValueOnce(html("", 302, { location: "https://www.r.example/" }))
      .mockResolvedValueOnce(html(`<a href="mailto:a@r.example">x</a>`));
    const [b] = await enrichBusinesses([biz(1, "http://r.example")]);
    expect(b!.email).toBe("a@r.example");
    expect(publicFetch.mock.calls.map((c) => c[0])).toEqual([
      "http://r.example/",
      "http://r.example/home",
      "https://www.r.example/",
    ]);

    publicFetch.mockReset();
    publicFetch.mockResolvedValue(html("", 302, { location: "/again" }));
    const [loop] = await enrichBusinesses([biz(2, "https://loop.example")]);
    expect(loop!.email).toBeNull();
    expect(publicFetch).toHaveBeenCalledTimes(4); // the page + 3 redirects, no more
  });

  it("never fetches a non-http(s) website", async () => {
    const [b] = await enrichBusinesses([biz(1, "file:///etc/passwd"), biz(2, "ftp://x.example")]);
    expect(b!.email).toBeNull();
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it("keeps no more than the concurrency limit in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    publicFetch.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return html("");
    });
    await enrichBusinesses(Array.from({ length: 20 }, (_, i) => biz(i, `https://s${i}.example`)));
    expect(publicFetch).toHaveBeenCalledTimes(20);
    expect(ENRICH_CONCURRENCY).toBe(6);
    expect(peak).toBe(6);
  });
});
