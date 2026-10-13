import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GetLeadsBusiness } from "@/types/get-leads";

const publicFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch }));

const { extractContacts, enrichBusinesses, ENRICH_CONCURRENCY, HOMEPAGE_MAX_BYTES, ENRICH_DEADLINE_MS } =
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

describe("extractContacts — linear time on hostile pages (ReDoS)", () => {
  // A homepage is owner-controlled and up to HOMEPAGE_MAX_BYTES; extraction
  // runs on the event loop, so a pathological page must not stall it.
  // Linear extraction takes up to ~60 ms per page here and ~240 ms on the
  // loaded CI runner; the unanchored EMAIL_RE this replaced is quadratic and
  // took 208 s on 500 KB of 'a'. The budget sits far from both.
  const BUDGET_MS = 2_000;
  const SIZE = 500 * 1024;
  const fill = (unit: string, size = SIZE) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const hostile: [string, string][] = [
    ["40 KB of 'a'", fill("a", 40 * 1024)],
    ["500 KB of 'a'", fill("a")],
    ["500 KB of 'a@'", fill("a@")],
    ["500 KB of 'a.a.'", fill("a.a.")],
    ["500 KB of '@a.a'", fill("@a.a")],
    ["500 KB of 'a@a.'", fill("a@a.")],
    ["500 KB of 'mailto:a'", fill("mailto:a")],
    ["500 KB of facebook links", fill("https://www.facebook.com/")],
    ["500 KB of instagram links", fill("https://instagram.com/a")],
    ["500 KB of '&#0'", fill("&#0")],
  ];
  it.each(hostile)(`%s completes in < ${BUDGET_MS} ms`, (_name, page) => {
    const t0 = performance.now();
    extractContacts(page, "https://x.example");
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("still finds an email at the end of a long run of local-part characters", () => {
    expect(extractContacts(`${"a".repeat(100_000)} hi@site.example`, "https://site.example").email).toBe(
      "hi@site.example",
    );
    // A local part longer than 64 characters keeps its last 64.
    expect(extractContacts(`${"b".repeat(70)}@site.example`, "https://site.example").email).toBe(
      `${"b".repeat(64)}@site.example`,
    );
  });

  it("never lets one match's domain become the next match's local part", () => {
    expect(extractContacts("a@one.example@two.example", "https://x.example").email).toBe(
      "a@one.example",
    );
    // On two.example's own site, a phantom "one.example@two.example" would
    // win the own-domain preference; the old regex never produced it.
    expect(extractContacts("x a@one.example@two.example", "https://two.example").email).toBe(
      "a@one.example",
    );
  });
});

describe("enrichBusinesses — concurrency is process-wide", () => {
  beforeEach(() => publicFetch.mockReset());

  it("5 parallel searches of 40 sites keep no more than ENRICH_CONCURRENCY fetches in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    publicFetch.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return html("");
    });
    await Promise.all(
      Array.from({ length: 5 }, (_, s) =>
        enrichBusinesses(Array.from({ length: 40 }, (_, i) => biz(i, `https://s${s}-${i}.example`))),
      ),
    );
    expect(publicFetch).toHaveBeenCalledTimes(200);
    expect(peak).toBe(ENRICH_CONCURRENCY);
  });
});

describe("enrichBusinesses — bounded deadline", () => {
  beforeEach(() => publicFetch.mockReset());

  it("a small search started after a huge one still returns within its own deadline", async () => {
    // Reviewer's repro: a 40-site search occupies every process-wide slot
    // continuously; a 1-site search that starts after it must not be
    // queued indefinitely behind it — its own deadline bounds the wait.
    // The big search's fetches stay open until released (5 s at the latest),
    // so a waiter that ignores its deadline takes 5 s, not ~60 ms: the 2 s
    // budget holds on a loaded runner and still fails that.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const safety = setTimeout(release, 5_000);
    publicFetch.mockImplementation(async () => {
      await gate;
      return html(`<a href="mailto:hi@big.example">x</a>`);
    });
    const bigSearch = enrichBusinesses(
      Array.from({ length: 40 }, (_, i) => biz(i, `https://big${i}.example`)),
      undefined,
      5_000,
    );

    const deadlineMs = 60;
    const t0 = performance.now();
    const [small] = await enrichBusinesses(
      [biz(999, "https://small.example")],
      undefined,
      deadlineMs,
    );
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(2_000);
    expect(small!.email).toBeNull();

    release();
    clearTimeout(safety);
    await bigSearch; // drain so it doesn't leak into later tests
  });

  it("a queued waiter leaves the queue when the deadline fires — no slot leak for a later call", async () => {
    publicFetch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return html("");
    });
    // 8 sites: 6 take every slot immediately, 2 sit in the wait queue.
    // deadlineMs (20) fires long before any of the 6 in-flight fetches
    // finish, so both queued waiters must leave the queue rather than
    // wait for a slot that eventually frees up.
    await enrichBusinesses(
      Array.from({ length: 8 }, (_, i) => biz(i, `https://a${i}.example`)),
      undefined,
      20,
    );

    publicFetch.mockReset();
    let inFlight = 0;
    let peak = 0;
    publicFetch.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return html("");
    });
    await enrichBusinesses(
      Array.from({ length: 6 }, (_, i) => biz(i, `https://b${i}.example`)),
      undefined,
      5_000,
    );
    expect(peak).toBe(ENRICH_CONCURRENCY);
  });

  it("an aborted caller signal stops the call promptly, well inside the default deadline", async () => {
    expect(ENRICH_DEADLINE_MS).toBe(30_000);

    // A fetch that did start would take 5 s; the 2 s budget holds on a loaded
    // runner and still fails a call that ignores the caller's abort.
    publicFetch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5_000));
      return html(`<a href="mailto:hi@ok.example">x</a>`);
    });
    const controller = new AbortController();
    controller.abort();

    const t0 = performance.now();
    const [b] = await enrichBusinesses([biz(1, "https://slow.example")], controller.signal);
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(2_000);
    expect(b!.email).toBeNull();
    expect(publicFetch).not.toHaveBeenCalled();
  });
});
