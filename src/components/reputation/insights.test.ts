// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reputation → Insights: every state, rendered for real (jsdom) from the
 * live sub-account doc and GET …/reputation/insights; only `fetch` and the
 * context are stubbed.
 */

const ctx = vi.hoisted(() => ({ subAccountId: "sa1", isAdmin: true, loading: false, subAccount: {} as Record<string, unknown> | null }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...rest }, children),
}));

import { ReputationInsights } from "./insights";

const LOC_A = "locations/e2e-velo-gqeberha";
const LOC_B = "locations/e2e-velo-gqeberha-north";
const LISTING = { locationName: LOC_A, title: "Velo Test Fibre — Gqeberha" };
const pair = (current: number, previous: number) => ({ current, previous });
const body = (over: Record<string, unknown> = {}) => ({
  location: { name: LOC_A, title: LISTING.title, isListing: true },
  range: "28d",
  window: { current: { start: "2026-08-17", end: "2026-09-13" }, previous: { start: "2026-07-20", end: "2026-08-16" } },
  lastDataDate: "2026-09-13",
  groups: {
    searchViews: pair(1200, 1000), mapsViews: pair(340, 400), calls: pair(14, 14), websiteClicks: pair(56, 50), directions: pair(9, 3),
    conversations: pair(0, 0), bookings: pair(2, 0), desktopViews: pair(540, 500), mobileViews: pair(1000, 900),
  },
  daily: [
    { date: "2026-09-12", searchViews: 40, mapsViews: 10, calls: 1, websiteClicks: 2, directions: 0, desktopViews: 20, mobileViews: 30 },
    { date: "2026-09-13", searchViews: 44, mapsViews: 12, calls: 0, websiteClicks: 1, directions: 1, desktopViews: 21, mobileViews: 35 },
  ],
  ...over,
});
const LOCATIONS = {
  truncated: false,
  accounts: [{ name: "accounts/x", accountName: "Fixture Group", locations: [
    { name: LOC_A, title: LISTING.title, address: "1 Fixture Road" },
    { name: LOC_B, title: "Velo Test Fibre — Gqeberha North", address: "9 Fixture Avenue" },
  ] }],
};

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
const json = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b });
let insights: (url: URL) => unknown;

beforeEach(() => {
  ctx.isAdmin = true;
  ctx.loading = false;
  ctx.subAccount = { googleEnabledByAgency: true, googleConnectionMeta: { connected: true }, googleListing: LISTING };
  insights = () => json(body());
  fetchMock.mockReset().mockImplementation(async (raw: string) => {
    const url = new URL(raw, "http://x");
    if (url.pathname === "/api/sub-accounts/sa1/google/locations") return json(LOCATIONS);
    if (url.pathname === "/api/sub-accounts/sa1/reputation/insights") return insights(url);
    throw new Error(`unexpected fetch ${raw}`);
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
  await act(async () => root.render(createElement(ReputationInsights)));
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const insightCalls = () => fetchMock.mock.calls.map(([u]) => new URL(String(u), "http://x")).filter((u) => u.pathname.endsWith("/insights"));
async function choose(testId: string, value: string) {
  const select = byId(testId) as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

describe("states before any call", () => {
  it("while the sub-account is still loading: loading, never gate-off, nothing fetched", async () => {
    ctx.loading = true;
    ctx.subAccount = null;
    await render();
    expect(byId("rep-insights-loading")).not.toBeNull();
    expect(byId("rep-insights-gate-off")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["gate off", { googleEnabledByAgency: false }, "rep-insights-gate-off"],
    ["not connected", { googleConnectionMeta: null }, "rep-insights-not-connected"],
    ["no listing", { googleListing: null }, "rep-insights-no-listing"],
  ])("%s → %s, and nothing is fetched", async (_label, patch, id) => {
    ctx.subAccount = { ...ctx.subAccount, ...patch };
    await render();
    expect(byId(id)).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(byId("rep-insights-tiles")).toBeNull();
  });
});

describe("the data", () => {
  it("loads the listing for 28d and shows the tiles, change vs the previous period, the charts and the device split", async () => {
    insights = () => new Promise(() => {});
    await render();
    expect(byId("rep-insights-loading")).not.toBeNull();
    insights = () => json(body());
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    const call = insightCalls().at(-1)!;
    expect(call.searchParams.get("range")).toBe("28d");
    expect(call.searchParams.get("location")).toBe(LOC_A);
    expect(byId("rep-insights-tile-searchViews-value")?.textContent).toBe("1,200");
    expect(byId("rep-insights-tile-searchViews-note")?.textContent).toBe("+200 vs previous 28 days");
    expect(byId("rep-insights-tile-mapsViews-note")?.textContent).toBe("−60 vs previous 28 days");
    expect(byId("rep-insights-tile-calls-note")?.textContent).toBe("no change vs previous 28 days");
    expect(byId("rep-insights-tile-websiteClicks-value")?.textContent).toBe("56");
    expect(byId("rep-insights-tile-directions-value")?.textContent).toBe("9");
    // Conversations stayed zero in both periods → no tile; bookings did not → a tile.
    expect(byId("rep-insights-tile-conversations")).toBeNull();
    expect(byId("rep-insights-tile-bookings-value")?.textContent).toBe("2");
    expect(byId("rep-insights-chart-views")).not.toBeNull();
    expect(byId("rep-insights-chart-actions")).not.toBeNull();
    expect(byId("rep-insights-devices")?.textContent).toContain("Desktop 540 (35%)");
    expect(byId("rep-insights-devices")?.textContent).toContain("Mobile 1,000 (65%)");
    expect(byId("rep-insights-data-through")?.textContent).toContain("13 Sept 2026");
    expect(byId("rep-insights-other-location")).toBeNull();
  });

  it("changing the range asks again", async () => {
    await render();
    await choose("rep-insights-range", "7d");
    expect(insightCalls().at(-1)!.searchParams.get("range")).toBe("7d");
  });

  it("an admin picks another visible location; the page says the review listing stays as it is", async () => {
    await render();
    const select = byId("rep-insights-location") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([LOC_A, LOC_B]);
    expect(select.value).toBe(LOC_A);
    insights = (url) => json(body({ location: { name: url.searchParams.get("location"), title: "Velo Test Fibre — Gqeberha North", isListing: false } }));
    await choose("rep-insights-location", LOC_B);
    expect(insightCalls().at(-1)!.searchParams.get("location")).toBe(LOC_B);
    expect(byId("rep-insights-other-location")?.textContent).toContain(`reviews stay on ${LISTING.title}`);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method && (init as RequestInit).method !== "GET")).toBe(false);
  });

  it("a member sees only the selected listing: no picker, no locations call", async () => {
    ctx.isAdmin = false;
    await render();
    expect(byId("rep-insights-location")?.tagName).not.toBe("SELECT");
    expect(byId("rep-insights-location")?.textContent).toContain(LISTING.title);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/google/locations"))).toBe(false);
  });

  it.each([
    ["access_not_approved", 424, "Google hasn't approved Business Profile API access for this project yet."],
    ["rate_limited", 424, "Couldn't load your other Google locations — showing the selected listing."],
    [undefined, 502, "Couldn't load your other Google locations — showing the selected listing."],
  ])("if the locations list cannot load (%s), the admin still sees the listing's insights — and is told why", async (code, status, line) => {
    fetchMock.mockImplementation(async (raw: string) =>
      String(raw).includes("/google/locations") ? json(code ? { code } : "<html>", status) : json(body()),
    );
    await render();
    expect([...(byId("rep-insights-location") as HTMLSelectElement).options].map((o) => o.value)).toEqual([LOC_A]);
    expect(byId("rep-insights-locations-error")?.textContent).toBe(line);
    expect(byId("rep-insights-tile-searchViews-value")?.textContent).toBe("1,200");
  });

  it("says nothing under the picker when the locations list loaded", async () => {
    await render();
    expect(byId("rep-insights-locations-error")).toBeNull();
  });

  it("empty: Google has no data for this range", async () => {
    const zero = Object.fromEntries(Object.keys(body().groups).map((k) => [k, pair(0, 0)]));
    insights = () => json(body({ groups: zero, lastDataDate: null, daily: [] }));
    await render();
    expect(byId("rep-insights-empty")).not.toBeNull();
    expect(byId("rep-insights-tiles")).toBeNull();
  });
});

describe("failures", () => {
  it("Google's quota-0 refusal → the not-approved sentence", async () => {
    insights = () => json({ code: "access_not_approved", error: "x" }, 502);
    await render();
    expect(byId("rep-insights-not-approved")?.textContent).toContain("Google hasn't approved Business Profile API access for this project yet.");
    expect(byId("rep-insights-error")).toBeNull();
  });

  it.each([
    ["transient", "Google is temporarily unavailable"],
    ["reconnect_required", "Reconnect Google"],
    ["no_listing", "No listing is selected"],
  ])("%s → rep-insights-error with its own sentence", async (code, text) => {
    insights = () => json({ code, error: "x" }, code === "transient" ? 502 : 409);
    await render();
    expect(byId("rep-insights-error")?.textContent).toContain(text);
  });

  it.each([
    ["not_found", 424, "This location no longer exists at Google, or this connection lost access to it."],
    ["not_configured", 503, "Google isn't configured on this deployment."],
    ["location_admin_only", 403, "Only a sub-account admin can view another location."],
    ["auth_expired", 424, "Google rejected this connection's credentials. Try again, or reconnect if it keeps happening."],
  ])("%s → its own sentence", async (code, status, text) => {
    insights = () => json({ code, error: "x" }, status);
    await render();
    expect(byId("rep-insights-error")?.textContent).toBe(text);
  });

  it("a network failure → the generic error", async () => {
    insights = () => Promise.reject(new TypeError("offline"));
    await render();
    expect(byId("rep-insights-error")?.textContent).toContain("Insights could not be loaded");
  });
});
