// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewsSection } from "./reviews-section";

/**
 * Every state of the synced-reviews section, rendered for real (jsdom) from
 * the GET /gbp/reviews payload; only `fetch` is stubbed.
 */

const URL_ = "/api/sub-accounts/sa1/gbp/reviews";
const SYNC = "/api/sub-accounts/sa1/gbp/sync";
const TRANSLATED = "(Translated by Google) Fine.\n\n(Original)\nGoed.";
const HOUR = 3600_000;

const summary = (over: Record<string, unknown> = {}) => ({
  averageRating: 3.6,
  totalReviewCount: 7,
  lastSuccessfulSyncAt: new Date(Date.now() - 2 * HOUR).toISOString(),
  lastRunAt: new Date(Date.now() - 2 * HOUR).toISOString(),
  lastRunStatus: "success",
  lastErrorKind: null,
  health: "ok",
  ...over,
});
const review = (id: string, over: Record<string, unknown> = {}) => ({
  reviewId: id,
  reviewer: { displayName: `Reviewer ${id}`, profilePhotoUrl: null, isAnonymous: false },
  starRating: 4,
  comment: `Comment ${id}`,
  createTime: "2026-08-20T09:00:00.000Z",
  updateTime: "2026-08-20T09:00:00.000Z",
  reply: null,
  ...over,
});

let container: HTMLDivElement;
let root: Root;
let payload: Record<string, unknown>;
let syncResult: Record<string, unknown>;
const fetchMock = vi.fn();

beforeEach(() => {
  payload = { summary: summary(), reviews: [review("r2"), review("r1")], runs: [] };
  syncResult = { run: { status: "success", created: 2, updated: 1, removed: 0, reconciliation: "full", errorKind: null, skipReason: null } };
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    if (key === `GET ${URL_}`) return { ok: true, status: 200, json: async () => payload };
    if (key === `POST ${SYNC}`) return { ok: true, status: 200, json: async () => syncResult };
    throw new Error(`unexpected fetch ${key}`);
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

async function render(props: { canSync?: boolean; reconnect?: boolean } = {}) {
  await act(async () =>
    root.render(createElement(ReviewsSection, { subAccountId: "sa1", canSync: props.canSync ?? true, reconnect: props.reconnect ?? false })),
  );
}
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe("summary", () => {
  it("shows rating, count, honest freshness and the cadence — never 'live'", async () => {
    await render();
    const text = byId("gbp-summary")?.textContent ?? "";
    expect(text).toContain("3.6");
    expect(text).toContain("7 reviews");
    expect(text).toMatch(/Last synced 2 hours ago \(.+\)/);
    expect(text).toContain("Syncs every 6 hours");
    expect(container.textContent?.toLowerCase()).not.toContain("live");
    expect(byId("gbp-health-ok")).not.toBeNull();
  });

  it("says never synced before the first sync", async () => {
    payload = { summary: null, reviews: [], runs: [] };
    await render();
    expect(byId("gbp-health-never_synced")).not.toBeNull();
    expect(byId("gbp-summary")?.textContent).toContain("Not synced yet");
    expect(byId("gbp-reviews-empty")).not.toBeNull();
  });
});

describe("health banners", () => {
  it.each([
    ["stale", "gbp-banner-stale", "may be out of date"],
    ["partial", "gbp-banner-partial", "didn't finish"],
    ["error", "gbp-banner-error", "failing"],
  ])("%s", async (health, testId, text) => {
    payload = { ...payload, summary: summary({ health }) };
    await render();
    expect(byId(`gbp-health-${health}`)).not.toBeNull();
    expect(byId(testId)?.textContent).toContain(text);
  });

  it("explains retention expiry in the error banner", async () => {
    payload = { summary: summary({ health: "error", lastErrorKind: "retention_expired" }), reviews: [], runs: [] };
    await render();
    expect(byId("gbp-banner-error")?.textContent).toContain("30-day");
  });

  it("reconnect: guidance plus the date of the cached reviews still shown", async () => {
    payload = { ...payload, summary: summary({ health: "reconnect_required" }) };
    await render();
    const banner = byId("gbp-banner-reconnect")?.textContent ?? "";
    expect(banner).toContain("Google access was revoked — reconnect to resume syncing.");
    expect(banner).toMatch(/Showing cached reviews from .+\./);
    expect(byId("gbp-review-r1")).not.toBeNull();
  });

  it("reconnect banner also shows when the connection itself is flagged", async () => {
    await render({ reconnect: true });
    expect(byId("gbp-banner-reconnect")).not.toBeNull();
    expect(byId("gbp-sync-now")).toBeNull();
  });

  it("no banner when healthy", async () => {
    await render();
    expect(container.querySelector('[data-testid^="gbp-banner-"]')).toBeNull();
  });
});

describe("reviews", () => {
  it("renders each review byte-exact in pre-wrap, with its owner reply", async () => {
    payload = {
      ...payload,
      reviews: [
        review("rt", { comment: TRANSLATED, reply: { comment: "Thanks!", updateTime: "2026-08-21T09:00:00Z" } }),
        review("ra", { reviewer: { displayName: "", profilePhotoUrl: null, isAnonymous: true }, comment: null, starRating: 1 }),
      ],
    };
    await render();
    const comment = byId("gbp-review-rt")?.querySelector('[data-testid="gbp-review-comment"]');
    expect(comment?.textContent).toBe(TRANSLATED);
    expect(comment?.className).toContain("whitespace-pre-wrap");
    expect(byId("gbp-review-rt")?.textContent).toContain("Thanks!");
    expect(byId("gbp-review-ra")?.textContent).toContain("Anonymous");
    expect(byId("gbp-review-ra")?.querySelector('[aria-label="1 out of 5 stars"]')).not.toBeNull();
  });

  it("keeps the server's order (newest first)", async () => {
    await render();
    const ids = Array.from(container.querySelectorAll('[data-testid^="gbp-review-r"]')).map((e) => e.getAttribute("data-testid"));
    expect(ids).toEqual(["gbp-review-r2", "gbp-review-r1"]);
  });
});

describe("Sync now", () => {
  it("is offered to admins only", async () => {
    await render({ canSync: false });
    expect(byId("gbp-sync-now")).toBeNull();
  });

  it("posts once, shows the result inline and reloads the list", async () => {
    await render();
    await act(async () => (byId("gbp-sync-now") as HTMLButtonElement).click());
    expect(fetchMock.mock.calls.filter(([u, i]) => u === SYNC && i?.method === "POST")).toHaveLength(1);
    expect(byId("gbp-sync-result")?.textContent).toContain("2 new, 1 updated, 0 removed");
    expect(fetchMock.mock.calls.filter(([u]) => u === URL_).length).toBe(2);
  });

  it("shows a skip or a failure inline, honestly", async () => {
    syncResult = { run: { status: "skipped", skipReason: "already_running", errorKind: null } };
    await render();
    await act(async () => (byId("gbp-sync-now") as HTMLButtonElement).click());
    expect(byId("gbp-sync-result")?.textContent).toContain("already running");
    syncResult = { run: { status: "failed", skipReason: null, errorKind: "rate_limited", created: 0, updated: 0, removed: 0 } };
    await act(async () => (byId("gbp-sync-now") as HTMLButtonElement).click());
    expect(byId("gbp-sync-result")?.textContent).toContain("rate_limited");
  });
});
