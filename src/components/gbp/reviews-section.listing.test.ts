// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewsSection } from "./reviews-section";

/**
 * The Reviews tab across listings (MULTI_LISTING_V1_PLAN.md PR 4), rendered
 * for real (jsdom); only `fetch` is stubbed. The listing dropdown appears
 * only with more than one listing, picking one asks the API for `?listing=`,
 * and each row (and each recent sync) names its listing only then.
 */

const BASE = "/api/sub-accounts/sa1/gbp/reviews";
const MAIN = { locationName: "locations/main", title: "Blitz Pretoria", main: true };
const NORTH = { locationName: "locations/north", title: "Blitz Gqeberha", main: false };

const review = (id: string, listing: { locationName: string; title: string }) => ({
  reviewId: id,
  docId: `doc-${id}`,
  reviewer: { displayName: `Reviewer ${id}`, profilePhotoUrl: null, isAnonymous: false },
  starRating: 4,
  comment: `Comment ${id}`,
  createTime: "2026-08-20T09:00:00.000Z",
  updateTime: "2026-08-20T09:00:00.000Z",
  reply: null,
  listing: { locationName: listing.locationName, title: listing.title },
});
const SUMMARY = {
  averageRating: 4, totalReviewCount: 2, lastSuccessfulSyncAt: new Date().toISOString(),
  lastRunAt: new Date().toISOString(), lastRunStatus: "success", lastErrorKind: null, health: "ok",
};
const run = (locationName: string) => ({
  trigger: "manual", locationName, status: "success", finishedAt: new Date().toISOString(),
  created: 0, updated: 0, removed: 0, errorKind: null, skipReason: null,
});

let container: HTMLDivElement;
let root: Root;
let respond: (url: string) => Record<string, unknown>;
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET" || !url.startsWith(BASE)) throw new Error(`unexpected fetch ${url}`);
    const body = respond(url);
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", vi.fn(() => true));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  expect(window.confirm).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(createElement(ReviewsSection, { subAccountId: "sa1", canSync: true, reconnect: false })));
}
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const lastUrl = () => fetchMock.mock.calls.at(-1)?.[0] as string;

async function pick(value: string) {
  const el = byId("gbp-filter-listing") as HTMLSelectElement;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  await act(async () => el.dispatchEvent(new Event("change", { bubbles: true })));
}

describe("one listing", () => {
  beforeEach(() => {
    respond = () => ({
      summary: SUMMARY, reviews: [review("r2", MAIN), review("r1", MAIN)], available: 2,
      runs: [run(MAIN.locationName)], scheduled: true, truncated: false, listings: [MAIN],
    });
  });

  it("no dropdown, no row labels, no run labels", async () => {
    await render();
    expect(byId("gbp-filters")).not.toBeNull();
    expect(byId("gbp-filter-listing")).toBeNull();
    expect(byId("gbp-review-listing-r1")).toBeNull();
    expect(byId("gbp-run-listing")).toBeNull();
    expect(container.textContent).not.toContain("Blitz Pretoria");
  });

  it("with no reviews at all, still no filter bar", async () => {
    respond = () => ({ summary: null, reviews: [], available: 0, runs: [], listings: [MAIN] });
    await render();
    expect(byId("gbp-filters")).toBeNull();
  });
});

describe("two listings", () => {
  beforeEach(() => {
    respond = (url) => {
      const onlyNorth = new URL(url, "http://x").searchParams.get("listing") === NORTH.locationName;
      const reviews = onlyNorth ? [review("n1", NORTH)] : [review("n1", NORTH), review("r1", MAIN)];
      return {
        summary: SUMMARY, reviews, available: reviews.length, runs: [run(NORTH.locationName), run(MAIN.locationName)],
        scheduled: true, truncated: false, listings: [MAIN, NORTH],
      };
    };
  });

  it("shows the dropdown — All listings first, then each by title — and labels every row", async () => {
    await render();
    const select = byId("gbp-filter-listing") as HTMLSelectElement;
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ["", "All listings"], [MAIN.locationName, MAIN.title], [NORTH.locationName, NORTH.title],
    ]);
    expect(select.value).toBe("");
    expect(byId("gbp-review-listing-n1")?.textContent).toBe(NORTH.title);
    expect(byId("gbp-review-listing-r1")?.textContent).toBe(MAIN.title);
    expect([...container.querySelectorAll('[data-testid="gbp-run-listing"]')].map((e) => e.textContent)).toEqual([
      ` · ${NORTH.title}`, ` · ${MAIN.title}`,
    ]);
  });

  it("picking a listing asks for ?listing= and shows only its reviews; All listings goes back", async () => {
    await render();
    expect(lastUrl()).toBe(BASE);
    await pick(NORTH.locationName);
    expect(lastUrl()).toBe(`${BASE}?listing=${encodeURIComponent(NORTH.locationName)}`);
    expect((byId("gbp-filter-listing") as HTMLSelectElement).value).toBe(NORTH.locationName);
    expect(byId("gbp-review-n1")).not.toBeNull();
    expect(byId("gbp-review-r1")).toBeNull();
    await pick("");
    expect(lastUrl()).toBe(BASE);
    expect(byId("gbp-review-r1")).not.toBeNull();
  });

  it("combines with the other filters, and Clear filters resets the listing too", async () => {
    await render();
    await pick(NORTH.locationName);
    await act(async () => (byId("gbp-filter-rating-4") as HTMLButtonElement).click());
    expect(lastUrl()).toBe(`${BASE}?listing=${encodeURIComponent(NORTH.locationName)}&rating=4`);
    await act(async () => (byId("gbp-filter-clear") as HTMLButtonElement).click());
    expect(lastUrl()).toBe(BASE);
  });

  it("rows key off docId, not reviewId — Google's reviewId is only unique within a listing", async () => {
    // Same reviewId ("dup") on two different listings, distinguished by docId.
    respond = () => ({
      summary: SUMMARY,
      reviews: [
        { ...review("dup", NORTH), docId: "doc-north-dup" },
        { ...review("dup", MAIN), docId: "doc-main-dup" },
      ],
      available: 2, runs: [], scheduled: true, truncated: false, listings: [MAIN, NORTH],
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await render();
    const duplicateKeyWarning = errorSpy.mock.calls.some((c) => String(c[0]).includes("same key"));
    expect(duplicateKeyWarning).toBe(false);
    errorSpy.mockRestore();
  });

  it("a removed listing's 400 resets the filter to All listings and refetches, with no user action", async () => {
    await render();
    await pick(NORTH.locationName);
    expect(new URL(lastUrl(), "http://x").searchParams.get("listing")).toBe(NORTH.locationName);

    // The listing was removed server-side: the next fetch (Sync now's
    // refresh) 400s on the now-stale filter.
    fetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") return { ok: true, status: 200, json: async () => ({ run: run(NORTH.locationName) }) };
      throw new Error(`unexpected fetch ${url}`);
    });
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 400, json: async () => ({ code: "invalid_filter", field: "listing" }) }));
    await act(async () => (byId("gbp-sync-now") as HTMLButtonElement).click());
    expect(lastUrl()).toBe(BASE);
    expect((byId("gbp-filter-listing") as HTMLSelectElement | null)?.value).toBe("");
  });

  it("keeps the dropdown when the picked listing has no reviews, so another can be picked", async () => {
    respond = (url) => ({
      summary: null, reviews: url === BASE ? [review("r1", MAIN)] : [], available: url === BASE ? 1 : 0,
      runs: [], listings: [MAIN, NORTH],
    });
    await render();
    await pick(NORTH.locationName);
    expect(byId("gbp-filter-listing")).not.toBeNull();
    expect(byId("gbp-reviews-empty")).not.toBeNull();
    await pick("");
    expect(byId("gbp-review-r1")).not.toBeNull();
  });
});
