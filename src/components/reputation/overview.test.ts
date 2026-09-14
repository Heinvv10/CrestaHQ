// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every state of Reputation → Overview, rendered for real (jsdom) from the
 * overview API payload; only `fetch` and the sub-account context are stubbed.
 */

vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ({ subAccountId: "sa1" }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...rest }, children),
}));

import { ReputationOverview } from "./overview";
import type { OverviewResponse } from "./types";

const API = "/api/sub-accounts/sa1/reputation/overview";

function payload(over: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    range: { preset: "90d", bucket: "week", from: "2026-06-16T10:00:00.000Z", to: "2026-09-14T10:00:00.000Z", previousFrom: "2026-03-18T10:00:00.000Z" },
    reviews: {
      count: 7, avgRating: 25 / 7, previous: { count: 3, avgRating: 3 },
      distribution: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 3 },
      response: { replied: 2, unreplied: 5, coverage: 2 / 7, replyHours: { avg: 3, median: 3, counted: 2, excluded: 0 } },
    },
    requests: { sent: 2, byChannel: { sms: 2 }, previous: null, countingSince: "2026-09-01T08:00:00.000Z" },
    trend: [
      { start: "2026-09-07T00:00:00.000Z", reviews: 0, avgRating: null, avgReplyHours: null, requests: 0 },
      { start: "2026-09-14T00:00:00.000Z", reviews: 7, avgRating: 25 / 7, avgReplyHours: 3, requests: 2 },
    ],
    reviewsUnavailable: null,
    listing: { averageRating: 3.6, totalReviewCount: 7 },
    health: "ok",
    lastSuccessfulSyncAt: "2026-09-14T09:00:00.000Z",
    lastErrorKind: null,
    lastReconciliation: "full",
    truncated: { reviews: false, requests: false },
    checklist: { googleConnected: true, listingSelected: true, reviewLinkConfigured: false, widgetExists: false, requestLogged: true },
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;
let body: unknown;
let status: number;
const fetchMock = vi.fn();

beforeEach(() => {
  body = payload();
  status = 200;
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (!url.startsWith(`${API}?range=`)) throw new Error(`unexpected fetch ${url}`);
    return { ok: status < 400, status, json: async () => body };
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(createElement(ReputationOverview)));
}
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const text = (id: string) => byId(id)?.textContent ?? null;

describe("states", () => {
  it("loading, before the API answers", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await render();
    expect(byId("rep-state-loading")).not.toBeNull();
    expect(byId("rep-tile-requests")).toBeNull();
  });

  it("error, when the API fails", async () => {
    status = 500;
    body = { error: "x" };
    await render();
    expect(byId("rep-state-error")).not.toBeNull();
  });

  it.each([
    ["gate_off", "rep-state-gate-off", "Google reviews are not enabled for this sub-account"],
    ["not_connected", "rep-state-not-connected", "not connected"],
    ["no_listing", "rep-state-no-listing", "No listing is selected"],
  ] as const)("%s: says why, hides review tiles, still shows requests", async (reason, id, words) => {
    body = payload({ reviewsUnavailable: reason, reviews: null, listing: null, health: null });
    await render();
    expect(text(id)).toContain(words);
    for (const t of ["rep-tile-avg", "rep-tile-count", "rep-tile-coverage", "rep-tile-reply-time", "rep-distribution", "rep-response", "rep-trend"]) {
      expect(byId(t)).toBeNull();
    }
    expect(text("rep-tile-requests-value")).toBe("2");
    expect(byId("rep-requests")).not.toBeNull();
    expect(byId("rep-checklist")).not.toBeNull();
  });

  it("never synced", async () => {
    body = payload({ health: "never_synced", reviews: { ...payload().reviews!, count: 0 } });
    await render();
    expect(byId("rep-state-never-synced")).not.toBeNull();
  });

  it.each([
    ["stale", "gbp-banner-stale"],
    ["reconnect_required", "gbp-banner-reconnect"],
    ["error", "gbp-banner-error"],
  ] as const)("%s: the reviews inbox's own banner", async (health, id) => {
    body = payload({ health });
    await render();
    expect(byId("rep-state-health")?.getAttribute("data-health")).toBe(health);
    expect(byId(id)).not.toBeNull();
    expect(byId(`gbp-health-${health}`)).not.toBeNull();
  });

  it("empty range", async () => {
    const r = payload().reviews!;
    body = payload({ reviews: { ...r, count: 0, avgRating: null, response: { ...r.response, replied: 0, unreplied: 0, coverage: null } }, requests: { sent: 0, byChannel: {}, previous: null, countingSince: null } });
    await render();
    expect(byId("rep-state-empty")).not.toBeNull();
    expect(text("rep-tile-avg-value")).toBe("—");
    expect(text("rep-tile-coverage-value")).toBe("—");
    expect(text("rep-requests-since")).toContain("No review requests have been logged yet");
  });
});

describe("ready", () => {
  it("shows the API's numbers, formatted", async () => {
    await render();
    expect(byId("rep-state-health")).toBeNull();
    expect(text("rep-tile-avg-value")).toBe("3.6");
    expect(text("rep-tile-avg-note")).toBe("+0.6 vs previous 90 days");
    expect(text("rep-tile-count-value")).toBe("7");
    expect(text("rep-tile-count-note")).toBe("+4 vs previous 90 days");
    expect(text("rep-tile-coverage-value")).toBe("29%");
    expect(text("rep-tile-reply-time-value")).toBe("3 h");
    expect(text("rep-tile-requests-value")).toBe("2");
    expect(text("rep-listing")).toContain("Google shows 3.6 from 7 reviews");
    expect(byId("rep-distribution-5")?.getAttribute("data-count")).toBe("3");
    expect(byId("rep-distribution-1")?.getAttribute("data-count")).toBe("1");
    expect(text("rep-response")).toContain("Time to latest reply — Google reports only the latest reply time");
    expect(text("rep-requests-since")).toMatch(/Counting since 1 Sept? 2026/);
    expect(text("rep-requests")).toContain("not linked one-to-one");
    expect(text("rep-requests-channels")).toBe("SMS: 2");
  });

  it("the checklist marks each item from the API", async () => {
    await render();
    expect(byId("rep-checklist-googleConnected")?.getAttribute("data-done")).toBe("true");
    expect(byId("rep-checklist-reviewLinkConfigured")?.getAttribute("data-done")).toBe("false");
    expect(byId("rep-checklist-requestLogged")?.getAttribute("data-done")).toBe("true");
    expect(text("rep-checklist")).toContain("3 of 5 done");
  });

  it("changing the range refetches with it", async () => {
    await render();
    expect(fetchMock).toHaveBeenLastCalledWith(`${API}?range=90d`, expect.anything());
    const select = byId("rep-range") as HTMLSelectElement;
    await act(async () => {
      select.value = "30d";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(fetchMock).toHaveBeenLastCalledWith(`${API}?range=30d`, expect.anything());
  });
});
