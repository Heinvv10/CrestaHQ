// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * public/embed/gbp-reviews.js — the feed's `display` (layout + theme) and the
 * mount hook, run for real in jsdom against a stubbed `fetch`. The carousel's
 * own behaviour (controls, motion, fallback) is embed-script.test.ts; this
 * file is split out only to keep both under the file-size limit.
 */

const SCRIPT = readFileSync(join(process.cwd(), "public/embed/gbp-reviews.js"), "utf8");
const API = "https://crm.example.test";
const ID = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const MAPS = "https://maps.google.com/?cid=1";
const WRITE = "https://search.google.com/local/writereview?placeid=abc";

const review = (n: number, over: Record<string, unknown> = {}) => ({
  id: `r${n}`,
  author: { name: `Reviewer ${n}`, photoUrl: null, anonymous: false },
  rating: n % 5 || 5,
  text: `Review text ${n}`,
  createdAt: `2026-08-0${n}T09:00:00.000Z`,
  updatedAt: `2026-08-0${n}T09:00:00.000Z`,
  reply: n === 1 ? { text: "Owner reply 1", updatedAt: "2026-08-01T12:00:00.000Z" } : null,
  ...over,
});
const feedBody = (display: unknown, over: Record<string, unknown> = {}) => ({
  version: 1,
  status: "ok",
  listing: { title: "Velo Test Fibre", mapsUri: MAPS, writeReviewUri: WRITE },
  rating: { average: 3.64, count: 7 },
  source: { name: "Google", attribution: "Reviews from Google" },
  ...(display === undefined ? {} : { display }),
  freshness: { lastSuccessfulSyncAt: "2026-09-10T08:00:00.000Z", stale: false, generatedAt: "2026-09-10T09:00:00.000Z" },
  reviews: [review(1), review(2), review(3)],
  ...over,
});

const fetchMock = vi.fn();
const respond = (body: unknown) => fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => body });
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
async function load(body: unknown) {
  respond(body);
  document.body.innerHTML = `<div id="w" data-crestahq-reviews="${ID}" data-api="${API}"><p class="static">fallback</p></div>`;
  new Function(SCRIPT)();
  await settle();
}
const box = () => document.getElementById("w")!;
const root = () => box().querySelector<HTMLElement>(".chq-reviews")!;
const cards = () => [...box().querySelectorAll<HTMLElement>(".chq-reviews__card")];

beforeEach(() => {
  document.head.innerHTML = "";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete (window as { crestahqReviews?: unknown }).crestahqReviews;
});

describe("layout", () => {
  it.each(["grid", "list"])("%s: every served review as a visible card, no carousel, nothing moving", async (layout) => {
    vi.useFakeTimers();
    await load(feedBody({ layout, theme: "light" }));
    expect(box().getAttribute("data-state")).toBe("ok");
    expect(root().classList.contains(`chq-reviews--${layout}`)).toBe(true);
    expect(box().querySelector(".chq-reviews__carousel, .chq-reviews__controls, .chq-reviews__slide")).toBeNull();
    expect(cards()).toHaveLength(3);
    expect(cards().every((c) => !c.hidden)).toBe(true);
    expect(cards().map((c) => c.querySelector(".chq-reviews__text")?.textContent)).toEqual(["Review text 1", "Review text 2", "Review text 3"]);
    expect(cards()[0].querySelector(".chq-reviews__author")?.textContent).toContain("Reviewer 1");
    expect(cards()[0].querySelector(".chq-reviews__reply")?.textContent).toBe("Response from the owner: Owner reply 1");
    expect(box().querySelector("ul.chq-reviews__cards")?.getAttribute("aria-label")).toBe("Google reviews");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the grid is a responsive CSS grid of cards at least 16rem wide", async () => {
    await load(feedBody({ layout: "grid", theme: "light" }));
    const css = document.getElementById("chq-reviews-css")?.textContent ?? "";
    expect(css).toContain(".chq-reviews--grid .chq-reviews__cards{grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))}");
    expect(css).toMatch(/\.chq-reviews__cards\{[^}]*display:grid/);
  });

  it("badge: title, one-decimal average, stars, count, attribution and the write-a-review link — and NO review text", async () => {
    await load(feedBody({ layout: "badge", theme: "light" }));
    expect(root().classList.contains("chq-reviews--badge")).toBe(true);
    expect(box().querySelector(".chq-reviews__title")?.textContent).toBe("Velo Test Fibre");
    expect(box().querySelector(".chq-reviews__rating")?.textContent).toBe("3.6 ★ · 7 reviews");
    expect(box().querySelector(".chq-reviews__stars")?.textContent).toBe("★★★★☆");
    const write = box().querySelector<HTMLAnchorElement>(".chq-reviews__write a")!;
    expect(write.textContent).toBe("Write a review");
    expect(write.href).toBe(WRITE);
    expect(write.rel).toContain("noopener");
    expect(box().querySelector(".chq-reviews__text, .chq-reviews__card, .chq-reviews__slide, .chq-reviews__author, .chq-reviews__reply")).toBeNull();
    for (const t of ["Review text", "Reviewer ", "Owner reply", "No Google reviews yet."]) expect(box().textContent).not.toContain(t);
  });

  it("badge: no write link without an http(s) writeReviewUri, and no stars without a rating", async () => {
    await load(feedBody({ layout: "badge", theme: "light" }, { listing: { title: "T", mapsUri: MAPS, writeReviewUri: "javascript:alert(1)" }, rating: null }));
    expect(box().querySelector(".chq-reviews__write")).toBeNull();
    expect(box().querySelector(".chq-reviews__stars, .chq-reviews__rating")).toBeNull();
    expect(box().textContent).not.toContain("No Google reviews yet.");
  });

  it.each([
    ["no display at all", undefined],
    ["display: null", null],
    ["an unknown layout", { layout: "masonry", theme: "light" }],
    ["a layout inherited from Object.prototype", { layout: "toString", theme: "light" }],
    ["a non-string layout", { layout: 2, theme: "light" }],
    ["carousel", { layout: "carousel", theme: "light" }],
  ])("%s → the carousel, exactly as before", async (_label, display) => {
    await load(feedBody(display));
    expect(root().classList.contains("chq-reviews--carousel")).toBe(true);
    expect(box().querySelector(".chq-reviews__carousel")).not.toBeNull();
    expect(box().querySelectorAll(".chq-reviews__slide")).toHaveLength(3);
    expect(box().querySelector(".chq-reviews__count")?.textContent).toBe("1 / 3");
    expect(box().querySelector(".chq-reviews__card, .chq-reviews__write")).toBeNull();
  });

  it.each(["carousel", "grid", "list", "badge"])("%s always renders the Google attribution, linked to Maps", async (layout) => {
    await load(feedBody({ layout, theme: "dark" }));
    const source = box().querySelector<HTMLAnchorElement>(".chq-reviews__source a")!;
    expect(source.textContent).toBe("Reviews from Google");
    expect(source.href).toBe(MAPS);
  });

  it.each(["grid", "list", "badge"])("%s labels stale data with its date", async (layout) => {
    await load(feedBody({ layout, theme: "light" }, { status: "stale", freshness: { lastSuccessfulSyncAt: "2026-09-01T08:00:00.000Z", stale: true, generatedAt: "x" } }));
    expect(box().getAttribute("data-state")).toBe("stale");
    expect(box().querySelector(".chq-reviews__stale")?.textContent).toMatch(/^Last updated .*2026/);
  });

  it.each(["grid", "list"])("%s: header only under a count with no reviews in the window; 'no reviews yet' without one", async (layout) => {
    await load(feedBody({ layout, theme: "light" }, { reviews: [] }));
    expect(cards()).toHaveLength(0);
    expect(box().textContent).not.toContain("No Google reviews yet.");
    await load(feedBody({ layout, theme: "light" }, { reviews: [], rating: null }));
    expect(box().textContent).toContain("No Google reviews yet.");
  });

  it("grid renders feed text as TEXT only", async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    await load(feedBody({ layout: "grid", theme: "light" }, { reviews: [review(1, { text: evil, author: { name: evil, photoUrl: null, anonymous: false } })] }));
    expect(box().querySelector("img")).toBeNull();
    expect(cards()[0].querySelector(".chq-reviews__text")?.textContent).toBe(evil);
  });
});

describe("theme", () => {
  it.each(["carousel", "grid", "list", "badge"])("dark adds the chq-reviews--dark modifier to %s", async (layout) => {
    await load(feedBody({ layout, theme: "dark" }));
    expect(root().classList.contains("chq-reviews--dark")).toBe(true);
    expect(document.getElementById("chq-reviews-css")?.textContent).toMatch(/\.chq-reviews--dark\{background:#111827;color:#f3f4f6/);
  });

  it.each([
    ["light", { layout: "grid", theme: "light" }],
    ["missing", { layout: "grid" }],
    ["unknown", { layout: "grid", theme: "neon" }],
  ])("%s theme → today's look, no modifier", async (_label, display) => {
    await load(feedBody(display));
    expect(root().classList.contains("chq-reviews--dark")).toBe(false);
  });
});

describe("window.crestahqReviews.mount — for a container added after load", () => {
  it("mounts it, revalidating the feed, and leaves an already-mounted container alone", async () => {
    await load(feedBody({ layout: "grid", theme: "light" }));
    expect(fetchMock).toHaveBeenLastCalledWith(`${API}/api/public/gbp/feed/${ID}`, { credentials: "omit" });
    const later = document.createElement("div");
    later.setAttribute("data-crestahq-reviews", ID);
    later.setAttribute("data-api", API);
    document.body.append(later);
    const hook = (window as unknown as { crestahqReviews: { mount: (el: Element) => void } }).crestahqReviews;
    hook.mount(later);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(`${API}/api/public/gbp/feed/${ID}`, { credentials: "omit", cache: "no-cache" });
    expect(later.getAttribute("data-state")).toBe("ok");
    expect(later.querySelectorAll(".chq-reviews__card")).toHaveLength(3);
    hook.mount(later);
    hook.mount(box());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the fallback of a later container when the feed fails", async () => {
    await load(feedBody({ layout: "grid", theme: "light" }));
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "not_found" }) });
    const later = document.createElement("div");
    later.setAttribute("data-crestahq-reviews", ID);
    later.setAttribute("data-api", API);
    later.innerHTML = "<p>static</p>";
    (window as unknown as { crestahqReviews: { mount: (el: Element) => void } }).crestahqReviews.mount(later);
    await settle();
    expect(later.getAttribute("data-state")).toBe("fallback");
    expect(later.innerHTML).toBe("<p>static</p>");
  });
});
