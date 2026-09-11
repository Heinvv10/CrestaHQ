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
/** ONE MediaQueryList, as a browser gives: `matches` is live and `change` can be dispatched. */
let motionListeners: Array<(e: unknown) => void> = [];
const motionQuery = {
  media: "(prefers-reduced-motion: reduce)",
  get matches() {
    return reduceMotion;
  },
  addEventListener: (_type: string, fn: (e: unknown) => void) => void motionListeners.push(fn),
  removeEventListener: (_type: string, fn: (e: unknown) => void) => void (motionListeners = motionListeners.filter((f) => f !== fn)),
};
function setReducedMotion(on: boolean) {
  reduceMotion = on;
  // A browser passes a MediaQueryListEvent to `change` listeners.
  motionListeners.forEach((fn) => fn({ type: "change", matches: on }));
}

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
const pauseButton = () => box().querySelector<HTMLButtonElement>(".chq-reviews__toggle")!;
const count = () => box().querySelector(".chq-reviews__count")?.textContent;
const respond = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  reduceMotion = false;
  document.head.innerHTML = "";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  motionListeners = [];
  vi.stubGlobal("matchMedia", () => motionQuery);
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

describe("WCAG 2.2.2 — the visitor stays in control of motion", () => {
  async function rotating() {
    vi.useFakeTimers();
    respond(feedBody());
    mountPage();
    await runScript();
  }

  it("has a labelled pause/play button that stops and restarts rotation", async () => {
    await rotating();
    expect(pauseButton().type).toBe("button");
    expect(pauseButton().getAttribute("aria-label")).toBe("Pause automatic rotation");
    pauseButton().click();
    expect(pauseButton().getAttribute("aria-label")).toBe("Start automatic rotation");
    vi.advanceTimersByTime(30_000);
    expect(count()).toBe("1 / 3");
    pauseButton().click();
    vi.advanceTimersByTime(8_000);
    expect(count()).toBe("2 / 3");
  });

  it("stops rotating for good once the visitor uses a control", async () => {
    await rotating();
    box().querySelector<HTMLButtonElement>('button[aria-label="Next review"]')!.click();
    expect(count()).toBe("2 / 3");
    const region = box().querySelector<HTMLElement>(".chq-reviews__carousel")!;
    region.dispatchEvent(new MouseEvent("mouseenter"));
    region.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(60_000);
    expect(count()).toBe("2 / 3");
    expect(box().querySelector("[aria-live]")?.getAttribute("aria-live")).toBe("polite");
  });

  it("focus on the pause/play button does not pause: pressing Play must play", async () => {
    await rotating();
    pauseButton().click();
    pauseButton().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    pauseButton().click();
    vi.advanceTimersByTime(8_000);
    expect(count()).toBe("2 / 3");
  });

  it("stops rotating for good once the visitor uses the keyboard", async () => {
    await rotating();
    box().querySelector<HTMLElement>(".chq-reviews__carousel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    vi.advanceTimersByTime(60_000);
    expect(count()).toBe("2 / 3");
  });

  it("stops when the visitor turns reduced motion ON mid-rotation, and hides the toggle", async () => {
    await rotating();
    vi.advanceTimersByTime(8_000);
    expect(count()).toBe("2 / 3");
    setReducedMotion(true);
    vi.advanceTimersByTime(60_000);
    expect(count()).toBe("2 / 3");
    expect(pauseButton().hidden).toBe(true);
  });

  it("restarts when reduced motion is turned OFF — only if the visitor never interacted", async () => {
    reduceMotion = true;
    await rotating();
    expect(pauseButton().hidden).toBe(true);
    setReducedMotion(false);
    expect(pauseButton().hidden).toBe(false);
    vi.advanceTimersByTime(8_000);
    expect(count()).toBe("2 / 3");
  });

  it("does not restart on reduced motion OFF after the visitor interacted", async () => {
    reduceMotion = true;
    await rotating();
    box().querySelector<HTMLButtonElement>('button[aria-label="Next review"]')!.click();
    setReducedMotion(false);
    vi.advanceTimersByTime(60_000);
    expect(count()).toBe("2 / 3");
  });

  it("drops its reduced-motion listener once the widget is gone (timer path)", async () => {
    await rotating();
    expect(motionListeners).toHaveLength(1);
    box().remove();
    vi.advanceTimersByTime(8_000);
    expect(motionListeners).toHaveLength(0);
  });

  it("drops its reduced-motion listener once the widget is gone (change path), starting nothing", async () => {
    reduceMotion = true;
    await rotating();
    box().remove();
    setReducedMotion(false);
    expect(motionListeners).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("moves focus to Next when reduced motion hides the focused pause/play button", async () => {
    await rotating();
    pauseButton().focus();
    expect(document.activeElement).toBe(pauseButton());
    setReducedMotion(true);
    expect(document.activeElement).toBe(box().querySelector('button[aria-label="Next review"]'));
  });

  it("clears its timer once the widget is removed from the page", async () => {
    await rotating();
    box().remove();
    vi.advanceTimersByTime(8_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the header never contradicts the list", () => {
  it("rounds the average to one decimal", async () => {
    reduceMotion = true;
    respond(feedBody({ rating: { average: 4.6666666, count: 12 } }));
    mountPage();
    await runScript();
    expect(box().querySelector(".chq-reviews__rating")?.textContent).toBe("4.7 ★ · 12 reviews");
  });

  it("with a count but no reviews in the window, shows only the header and attribution", async () => {
    respond(feedBody({ rating: { average: 4.2, count: 9 }, reviews: [] }));
    mountPage();
    await runScript();
    expect(box().querySelector(".chq-reviews__rating")?.textContent).toBe("4.2 ★ · 9 reviews");
    expect(box().querySelector(".chq-reviews__source")?.textContent).toBe("Reviews from Google");
    expect(box().querySelector(".chq-reviews__carousel")).toBeNull();
    expect(box().textContent).not.toContain("No Google reviews yet.");
  });
});
