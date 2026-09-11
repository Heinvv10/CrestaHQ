// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewsSection } from "./reviews-section";

/**
 * The inbox filter bar on the synced-reviews section, rendered for real
 * (jsdom); only `fetch` is stubbed. Every filter reaches the API as a query
 * parameter; the count, the filtered-empty state and a refused filter each
 * render.
 */

// Before any Date is made: the viewer is in UTC+2 (no DST).
process.env.TZ = "Africa/Johannesburg";

const BASE = "/api/sub-accounts/sa1/gbp/reviews";

const review = (id: string) => ({
  reviewId: id,
  docId: `doc-${id}`,
  reviewer: { displayName: `Reviewer ${id}`, profilePhotoUrl: null, isAnonymous: false },
  starRating: 4,
  comment: `Comment ${id}`,
  createTime: "2026-08-20T09:00:00.000Z",
  updateTime: "2026-08-20T09:00:00.000Z",
  reply: null,
});
const SUMMARY = {
  averageRating: 4, totalReviewCount: 2, lastSuccessfulSyncAt: new Date().toISOString(),
  lastRunAt: new Date().toISOString(), lastRunStatus: "success", lastErrorKind: null, health: "ok",
};

let container: HTMLDivElement;
let root: Root;
let respond: (url: string) => { status: number; body: unknown };
const fetchMock = vi.fn();

beforeEach(() => {
  respond = () => ({ status: 200, body: { summary: SUMMARY, reviews: [review("r2"), review("r1")], available: 2, runs: [], scheduled: true, truncated: false } });
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET" || !url.startsWith(BASE)) throw new Error(`unexpected fetch ${url}`);
    const { status, body } = respond(url);
    return { ok: status < 400, status, json: async () => body };
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("alert", vi.fn());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  expect(window.confirm).not.toHaveBeenCalled();
  expect(window.alert).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(createElement(ReviewsSection, { subAccountId: "sa1", canSync: true, reconnect: false })));
}
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const lastUrl = () => fetchMock.mock.calls.at(-1)?.[0] as string;

async function setValue(id: string, value: string) {
  const el = byId(id) as HTMLInputElement | HTMLSelectElement;
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  await act(async () => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("filter bar", () => {
  it("asks for the unfiltered list first and shows the count", async () => {
    await render();
    expect(fetchMock.mock.calls[0][0]).toBe(BASE);
    expect(byId("gbp-filter-count")?.textContent).toBe("Showing 2 of 2 reviews");
  });

  it("sends each star as a comma list, and toggles it off again", async () => {
    await render();
    await act(async () => (byId("gbp-filter-rating-1") as HTMLButtonElement).click());
    expect(lastUrl()).toBe(`${BASE}?rating=1`);
    expect(byId("gbp-filter-rating-1")?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => (byId("gbp-filter-rating-2") as HTMLButtonElement).click());
    expect(lastUrl()).toBe(`${BASE}?rating=1%2C2`);
    await act(async () => (byId("gbp-filter-rating-1") as HTMLButtonElement).click());
    expect(lastUrl()).toBe(`${BASE}?rating=2`);
  });

  it("sends replied, the date range and the sort", async () => {
    await render();
    await setValue("gbp-filter-replied", "unreplied");
    expect(lastUrl()).toBe(`${BASE}?replied=unreplied`);
    await setValue("gbp-filter-from", "2026-08-01");
    await setValue("gbp-filter-to", "2026-08-31");
    await setValue("gbp-filter-sort", "oldest");
    // The dates are the viewer's LOCAL days (this file runs in UTC+2): from local
    // midnight up to the next local midnight, with the offset — the same days
    // the list shows.
    const q = new URLSearchParams({
      replied: "unreplied", from: "2026-08-01T00:00:00+02:00", to: "2026-09-01T00:00:00+02:00", sort: "oldest",
    });
    expect(lastUrl()).toBe(`${BASE}?${q}`);
  });

  it("shows how many of the reviews match", async () => {
    respond = (url) => ({
      status: 200,
      body: { summary: SUMMARY, reviews: url.includes("rating") ? [review("r1")] : [review("r2"), review("r1")], available: 2, runs: [] },
    });
    await render();
    await act(async () => (byId("gbp-filter-rating-4") as HTMLButtonElement).click());
    expect(byId("gbp-filter-count")?.textContent).toBe("Showing 1 of 2 reviews");
    expect(byId("gbp-review-r2")).toBeNull();
  });

  it("says when nothing matches, and Clear filters brings everything back", async () => {
    respond = (url) => ({
      status: 200,
      body: { summary: SUMMARY, reviews: url === BASE ? [review("r2"), review("r1")] : [], available: 2, runs: [] },
    });
    await render();
    await act(async () => (byId("gbp-filter-rating-1") as HTMLButtonElement).click());
    expect(byId("gbp-reviews-empty-filtered")?.textContent).toContain("No reviews match these filters");
    expect(byId("gbp-reviews-empty")).toBeNull();
    await act(async () => (byId("gbp-filter-clear") as HTMLButtonElement).click());
    expect(lastUrl()).toBe(BASE);
    expect(byId("gbp-review-r1")).not.toBeNull();
  });

  it("shows a refused filter inline and keeps the reviews on screen", async () => {
    respond = (url) =>
      url === BASE
        ? { status: 200, body: { summary: SUMMARY, reviews: [review("r1")], available: 1, runs: [] } }
        : { status: 400, body: { code: "invalid_filter", field: "to", error: "Invalid filter: to" } };
    await render();
    await setValue("gbp-filter-from", "2026-08-31");
    await setValue("gbp-filter-to", "2026-08-01");
    expect(byId("gbp-filter-error")?.textContent).toContain("“To” date");
    expect(byId("gbp-review-r1")).not.toBeNull();
    expect(byId("gbp-reviews-load-error")).toBeNull();
  });

  it("a slow older response never overwrites a newer filter", async () => {
    let releaseOld!: () => void;
    const old = new Promise<void>((r) => (releaseOld = r));
    respond = (url) => ({
      status: 200,
      body: {
        summary: SUMMARY, available: 2, runs: [],
        reviews: url.endsWith("?rating=1") ? [review("old")] : url.includes("rating=1%2C2") ? [review("new")] : [review("r2"), review("r1")],
      },
    });
    const plain = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("?rating=1")) await old;
      return plain(url, init);
    });
    await render();
    await act(async () => void (byId("gbp-filter-rating-1") as HTMLButtonElement).click());
    await act(async () => void (byId("gbp-filter-rating-2") as HTMLButtonElement).click());
    expect(byId("gbp-review-new")).not.toBeNull();
    await act(async () => {
      releaseOld();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(byId("gbp-review-new")).not.toBeNull();
    expect(byId("gbp-review-old")).toBeNull();
  });

  it("is not offered when there are no reviews at all", async () => {
    respond = () => ({ status: 200, body: { summary: null, reviews: [], available: 0, runs: [] } });
    await render();
    expect(byId("gbp-filters")).toBeNull();
    expect(byId("gbp-reviews-empty")).not.toBeNull();
  });
});
