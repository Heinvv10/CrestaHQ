// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every state of Reputation → Overview, rendered for real (jsdom) from the
 * overview API payload; only `fetch` and the sub-account context are stubbed.
 */

const ctx = vi.hoisted(() => ({ subAccountId: "sa1", isAdmin: true }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...rest }, children),
}));

// The dialog has its own test (send-review-request.test.ts); here only that it is mounted and refreshes.
const sendButton = vi.hoisted(() => ({ onSent: null as null | (() => void) }));
vi.mock("./send-review-request", () => ({
  SendReviewRequestButton: ({ onSent }: { onSent: () => void }) => {
    sendButton.onSent = onSent;
    return createElement("button", { "data-testid": "rep-send-open" }, "Send Review Request");
  },
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
      sentiment: { positive: 3, neutral: 2, negative: 2, notAnalysed: 0, failed: 0 },
      response: { replied: 2, unreplied: 5, coverage: 2 / 7, replyHours: { avg: 3, median: 3, counted: 2, excluded: 0 } },
    },
    requests: { sent: 2, byChannel: { sms: 2 }, bySource: { dispatcher: 1, workflow: 1 }, failed: 0, previous: null, countingSince: "2026-09-01T08:00:00.000Z" },
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
    reviewsAi: { enabled: true, configured: true, running: false, lastRun: null },
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
  ctx.isAdmin = true;
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
    for (const t of ["rep-tile-avg", "rep-tile-count", "rep-tile-coverage", "rep-tile-reply-time", "rep-distribution", "rep-response", "rep-trend", "rep-sentiment"]) {
      expect(byId(t)).toBeNull();
    }
    expect(text("rep-tile-requests-value")).toBe("2");
    expect(byId("rep-requests")).not.toBeNull();
    expect(byId("rep-checklist")).not.toBeNull();
  });

  it("never synced — an admin is told to run Sync now", async () => {
    body = payload({ health: "never_synced", reviews: { ...payload().reviews!, count: 0 } });
    await render();
    expect(text("rep-state-never-synced")).toBe("Reviews have not been synced yet. Run Sync now on the Reviews tab.");
  });

  it("never synced — a member is not told to press a button they do not have", async () => {
    ctx.isAdmin = false;
    body = payload({ health: "never_synced", reviews: { ...payload().reviews!, count: 0 } });
    await render();
    expect(text("rep-state-never-synced")).toBe("Reviews have not been synced yet. A sub-account admin can run Sync now on the Reviews tab.");
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
    body = payload({ reviews: { ...r, count: 0, avgRating: null, response: { ...r.response, replied: 0, unreplied: 0, coverage: null } }, requests: { sent: 0, byChannel: {}, bySource: {}, failed: 0, previous: null, countingSince: null } });
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
    expect(text("rep-requests-since")).toMatch(/^Counting since 1 Sept? 2026 — the first logged request\. Earlier requests were not logged\.$/);
    expect(text("rep-tile-requests-note")).toBe("Since the first logged request");
    // Every sender is logged now (SP5 d1): no "not counted yet" note anywhere.
    expect(byId("rep-requests-scope")).toBeNull();
    expect(byId("rep-tile-requests-scope")).toBeNull();
    expect(text("rep-requests")).toContain("not linked one-to-one");
    expect(text("rep-requests-channels")).toBe("SMS: 2");
    expect(text("rep-requests-sources")).toBe("Request review & triggers: 1 · Workflows: 1");
    expect(byId("rep-requests-failed")).toBeNull();
  });

  it("names failed sends apart from requests sent", async () => {
    body = payload({ requests: { ...payload().requests, failed: 2 } });
    await render();
    expect(text("rep-tile-requests-value")).toBe("2");
    expect(text("rep-requests-failed")).toBe("2 more review asks failed to send and are not counted.");
  });

  it("the checklist marks each item from the API", async () => {
    await render();
    expect(byId("rep-checklist-googleConnected")?.getAttribute("data-done")).toBe("true");
    expect(byId("rep-checklist-reviewLinkConfigured")?.getAttribute("data-done")).toBe("false");
    expect(byId("rep-checklist-requestLogged")?.getAttribute("data-done")).toBe("true");
    expect(text("rep-checklist")).toContain("3 of 5 done");
    // The settings page opens on its Admin tab; the label names the tab the link cannot select.
    const link = byId("rep-checklist-reviewLinkConfigured")?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/sa/sa1/dashboard/settings");
    expect(link?.textContent).toBe("Set your review link (Settings Sub-Account → Messaging tab)");
  });

  it("offers Send Review Request, and a successful send refreshes the numbers", async () => {
    await render();
    expect(text("rep-send-open")).toBe("Send Review Request");
    const calls = fetchMock.mock.calls.length;
    await act(async () => sendButton.onSent?.());
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
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

describe("sentiment card (SP5 b)", () => {
  it("shows the API's counts, and Analyse now reloads the overview", async () => {
    await render();
    expect(byId("rep-sentiment-positive")?.getAttribute("data-count")).toBe("3");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, status: 202, json: async () => ({ started: true, aiConfigured: true }) };
      return { ok: true, status: 200, json: async () => payload({ reviews: { ...payload().reviews!, sentiment: { positive: 4, neutral: 2, negative: 1, notAnalysed: 0, failed: 0 } }, reviewsAi: { enabled: true, configured: true, running: false, lastRun: { classified: 1, skipped: 0, failed: 0, at: "2026-09-14T10:01:00.000Z", reason: null } } }) };
    });
    await act(async () => (byId("rep-sentiment-analyse") as HTMLButtonElement).click());
    expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/reputation/sentiment/run", { method: "POST" });
    expect(byId("rep-sentiment-positive")?.getAttribute("data-count")).toBe("4");
  });

  it("gate off: the card says Reviews AI is off", async () => {
    body = payload({ reviewsAi: { enabled: false, configured: true, running: false, lastRun: null } });
    await render();
    expect(byId("rep-sentiment-gate-off")).not.toBeNull();
  });
});

describe("a failed re-read while polling (SP5 b)", () => {
  it("keeps the overview (and the polling card) on screen", async () => {
    await render();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, status: 202, json: async () => ({ started: true, aiConfigured: true }) };
      return { ok: false, status: 502, json: async () => ({ error: "bad gateway" }) };
    });
    await act(async () => (byId("rep-sentiment-analyse") as HTMLButtonElement).click());
    expect(byId("rep-state-error")).toBeNull();
    expect(byId("rep-sentiment")).not.toBeNull();
    expect(byId("rep-sentiment-analyse")?.hasAttribute("disabled")).toBe(true); // still waiting
  });

  it("a failed FIRST load still shows the error", async () => {
    status = 502;
    await render();
    expect(byId("rep-state-error")).not.toBeNull();
  });
});
