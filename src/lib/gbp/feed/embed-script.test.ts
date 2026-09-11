// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../../../next.config";

/**
 * public/embed/gbp-reviews.js — the framework-free embed, run for real in
 * jsdom against a stubbed `fetch` and `matchMedia`: the static fallback
 * survives every failure, feed text only ever lands as text, the controls
 * and keyboard move the carousel, and reduced motion stops auto-advance.
 */

const SCRIPT = readFileSync(join(process.cwd(), "public/embed/gbp-reviews.js"), "utf8");
const API = "https://crm.example.test";
const ID = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const FALLBACK = '<p class="static">Rated 4.8 on Google — <a href="https://maps.example/">read our reviews</a></p>';

const review = (n: number, over: Record<string, unknown> = {}) => ({
  id: `r${n}`,
  author: { name: `Reviewer ${n}`, photoUrl: null, anonymous: false },
  rating: n % 5 || 5,
  text: `Review text ${n}`,
  createdAt: `2026-08-0${n}T09:00:00.000Z`,
  updatedAt: `2026-08-0${n}T09:00:00.000Z`,
  reply: null,
  ...over,
});
const feedBody = (over: Record<string, unknown> = {}) => ({
  version: 1,
  status: "ok",
  listing: { title: "Velo Test Fibre", mapsUri: "https://maps.google.com/?cid=1", writeReviewUri: null },
  rating: { average: 3.6, count: 7 },
  source: { name: "Google", attribution: "Reviews from Google" },
  freshness: { lastSuccessfulSyncAt: "2026-09-10T08:00:00.000Z", stale: false, generatedAt: "2026-09-10T09:00:00.000Z" },
  reviews: [review(1), review(2), review(3)],
  ...over,
});

let reduceMotion = false;
const fetchMock = vi.fn();

function mountPage(html = `<div id="w" data-crestahq-reviews="${ID}" data-api="${API}/">${FALLBACK}</div>`) {
  document.body.innerHTML = html;
}
async function runScript() {
  new Function(SCRIPT)();
  // Let the fetch → json → render chain settle.
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
const box = () => document.getElementById("w")!;
const slides = () => [...box().querySelectorAll<HTMLElement>(".chq-reviews__slide")];
const visible = () => slides().filter((s) => !s.hidden).map((s) => s.querySelector(".chq-reviews__text")?.textContent);
const respond = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  reduceMotion = false;
  document.head.innerHTML = "";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") && reduceMotion, media: q }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("loading and the fallback contract", () => {
  it("marks loading and keeps the static fallback visible while the feed is in flight", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    mountPage();
    await runScript();
    expect(box().getAttribute("data-state")).toBe("loading");
    expect(box().innerHTML).toBe(FALLBACK);
    expect(fetchMock).toHaveBeenCalledWith(`${API}/api/public/gbp/feed/${ID}`, { credentials: "omit" });
  });

  it.each([
    ["an HTTP error", () => respond({ error: "not_found" }, 404)],
    ["an HTTP error, even one whose body looks like a feed", () => respond(feedBody(), 500)],
    ["a network error", () => fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))],
    ["an unavailable feed", () => respond(feedBody({ status: "unavailable", rating: null, reviews: [] }))],
    ["an unknown contract version", () => respond(feedBody({ version: 2 }))],
    ["a body that is not JSON", () => fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } })],
  ])("leaves the fallback untouched on %s", async (_label, arrange) => {
    arrange();
    mountPage();
    await runScript();
    expect(box().getAttribute("data-state")).toBe("fallback");
    expect(box().innerHTML).toBe(FALLBACK);
  });

  it("does nothing but fall back without an id or api", async () => {
    mountPage(`<div id="w" data-crestahq-reviews="${ID}">${FALLBACK}</div>`);
    await runScript();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(box().getAttribute("data-state")).toBe("fallback");
    expect(box().innerHTML).toBe(FALLBACK);
  });
});

describe("live data", () => {
  it("replaces the fallback with title, rating, attribution link and the first review", async () => {
    reduceMotion = true;
    respond(feedBody());
    mountPage();
    await runScript();
    expect(box().getAttribute("data-state")).toBe("ok");
    expect(box().querySelector(".static")).toBeNull();
    expect(box().querySelector(".chq-reviews__title")?.textContent).toBe("Velo Test Fibre");
    expect(box().querySelector(".chq-reviews__rating")?.textContent).toContain("3.6");
    expect(box().querySelector(".chq-reviews__rating")?.textContent).toContain("7 reviews");
    const source = box().querySelector<HTMLAnchorElement>(".chq-reviews__source a")!;
    expect(source.textContent).toBe("Reviews from Google");
    expect(source.href).toBe("https://maps.google.com/?cid=1");
    expect(source.rel).toContain("noopener");
    expect(box().querySelector(".chq-reviews__stale")).toBeNull();
    expect(visible()).toEqual(["Review text 1"]);
    expect(box().querySelector("[aria-live]")?.getAttribute("aria-live")).toBe("polite");
  });

  it("renders feed text as TEXT only — markup in a review never becomes an element", async () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    respond(feedBody({
      listing: { title: evil, mapsUri: "javascript:alert(1)", writeReviewUri: null },
      reviews: [review(1, { text: evil, author: { name: evil, photoUrl: null, anonymous: false }, reply: { text: evil, updatedAt: "2026-08-02T00:00:00.000Z" } })],
    }));
    mountPage();
    await runScript();
    expect(box().querySelector("img, script")).toBeNull();
    expect(box().querySelector(".chq-reviews__text")?.textContent).toBe(evil);
    expect(box().querySelector(".chq-reviews__title")?.textContent).toBe(evil);
    // A non-http(s) link from the feed is not made clickable.
    expect(box().querySelector(".chq-reviews__source a")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("labels stale data with the date it was last updated", async () => {
    respond(feedBody({ status: "stale", freshness: { lastSuccessfulSyncAt: "2026-09-01T08:00:00.000Z", stale: true, generatedAt: "2026-09-10T09:00:00.000Z" } }));
    mountPage();
    await runScript();
    expect(box().getAttribute("data-state")).toBe("stale");
    const label = box().querySelector(".chq-reviews__stale")?.textContent ?? "";
    expect(label).toMatch(/^Last updated /);
    expect(label).toContain("2026");
  });

  it("says so, rather than inventing anything, when there are no reviews", async () => {
    respond(feedBody({ rating: null, reviews: [] }));
    mountPage();
    await runScript();
    expect(box().getAttribute("data-state")).toBe("ok");
    expect(box().querySelector(".chq-reviews__rating")).toBeNull();
    expect(slides()).toHaveLength(0);
    expect(box().textContent).toContain("No Google reviews yet.");
  });

  it("injects its CSS once for several widgets on one page", async () => {
    respond(feedBody());
    mountPage(`<div id="w" data-crestahq-reviews="${ID}" data-api="${API}">a</div><div data-crestahq-reviews="${ID}" data-api="${API}">b</div>`);
    await runScript();
    await runScript();
    expect(document.querySelectorAll("style#chq-reviews-css")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("manual controls", () => {
  it("prev/next buttons with aria-labels move the carousel, wrapping around", async () => {
    reduceMotion = true;
    respond(feedBody());
    mountPage();
    await runScript();
    const next = box().querySelector<HTMLButtonElement>('button[aria-label="Next review"]')!;
    const prev = box().querySelector<HTMLButtonElement>('button[aria-label="Previous review"]')!;
    expect(next.type).toBe("button");
    next.click();
    expect(visible()).toEqual(["Review text 2"]);
    expect(box().querySelector(".chq-reviews__count")?.textContent).toBe("2 / 3");
    prev.click();
    prev.click();
    expect(visible()).toEqual(["Review text 3"]);
  });

  it("the arrow keys move it too", async () => {
    reduceMotion = true;
    respond(feedBody());
    mountPage();
    await runScript();
    const region = box().querySelector<HTMLElement>(".chq-reviews__carousel")!;
    expect(region.tabIndex).toBe(0);
    region.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(visible()).toEqual(["Review text 2"]);
    region.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(visible()).toEqual(["Review text 1"]);
  });
});

describe("motion", () => {
  it("never auto-advances when the visitor prefers reduced motion", async () => {
    reduceMotion = true;
    vi.useFakeTimers();
    respond(feedBody());
    mountPage();
    await runScript();
    vi.advanceTimersByTime(60_000);
    expect(visible()).toEqual(["Review text 1"]);
  });

  it("otherwise auto-advances no faster than every 8s, and pauses on hover and focus", async () => {
    vi.useFakeTimers();
    respond(feedBody());
    mountPage();
    await runScript();
    vi.advanceTimersByTime(7_999);
    expect(visible()).toEqual(["Review text 1"]);
    vi.advanceTimersByTime(1);
    expect(visible()).toEqual(["Review text 2"]);
    // Rotating on its own, announcements are off (WAI carousel pattern).
    expect(box().querySelector("[aria-live]")?.getAttribute("aria-live")).toBe("off");

    const region = box().querySelector<HTMLElement>(".chq-reviews__carousel")!;
    region.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(30_000);
    expect(visible()).toEqual(["Review text 2"]);
    expect(box().querySelector("[aria-live]")?.getAttribute("aria-live")).toBe("polite");
    region.dispatchEvent(new MouseEvent("mouseleave"));
    region.dispatchEvent(new FocusEvent("focusin"));
    vi.advanceTimersByTime(30_000);
    expect(visible()).toEqual(["Review text 2"]);
    region.dispatchEvent(new FocusEvent("focusout"));
    vi.advanceTimersByTime(8_000);
    expect(visible()).toEqual(["Review text 3"]);
  });
});

describe("how the app serves it", () => {
  it("as JavaScript with a short public cache, like /widget.js", async () => {
    const rules = (await nextConfig.headers!()).filter((r) => r.source === "/embed/gbp-reviews.js");
    expect(rules).toHaveLength(1);
    expect(rules[0].headers).toEqual(
      expect.arrayContaining([
        { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        { key: "Cache-Control", value: "public, max-age=300, s-maxage=300" },
      ]),
    );
  });
});
