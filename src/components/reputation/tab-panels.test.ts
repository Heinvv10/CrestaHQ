// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reputation → Reviews and → Widgets: which existing component they mount,
 * and what they say instead when Google is off / not set up. The mounted
 * components are stubbed here — their own tests cover them.
 */

const ctx = vi.hoisted(() => ({
  subAccountId: "sa1",
  isAdmin: true,
  loading: false,
  subAccount: {} as Record<string, unknown> | null,
}));
const seen = vi.hoisted(() => ({ reviews: [] as Array<Record<string, unknown>> }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => createElement("a", { href }, children),
}));
vi.mock("@/components/gbp/reviews-section", () => ({
  ReviewsSection: (props: Record<string, unknown>) => (seen.reviews.push(props), createElement("div", { "data-testid": "stub-reviews" })),
}));
vi.mock("@/components/gbp/widget-section", () => ({
  WidgetSection: () => createElement("div", { "data-testid": "stub-widget" }),
}));
vi.mock("@/components/settings/sub-account-google-review-section", () => ({
  SubAccountGoogleReviewSection: () => createElement("div", { "data-testid": "stub-review-settings" }),
}));

import { ReputationReviews, ReputationSettings, ReputationWidgets } from "./tab-panels";

const connected = (over: Record<string, unknown> = {}) => ({
  googleEnabledByAgency: true,
  googleConnectionMeta: { connected: true, ...over },
  googleListing: { locationName: "locations/x" },
});

let container: HTMLDivElement;
let root: Root;
/** GET /google/status — is Google OAuth configured on this deployment? */
let configured: boolean | "fail" | "pending";
const fetchMock = vi.fn();
beforeEach(() => {
  Object.assign(ctx, { isAdmin: true, loading: false, subAccount: connected() });
  seen.reviews.length = 0;
  configured = true;
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (url !== "/api/sub-accounts/sa1/google/status") throw new Error(`unexpected fetch ${url}`);
    if (configured === "pending") return new Promise(() => {});
    if (configured === "fail") throw new Error("network");
    return { ok: true, json: async () => ({ configured }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (c: () => React.ReactNode) => act(async () => root.render(createElement(c)));
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe("Reviews tab", () => {
  it("loading", async () => {
    ctx.loading = true;
    await render(ReputationReviews);
    expect(byId("rep-reviews-loading")).not.toBeNull();
  });

  it("gate off", async () => {
    ctx.subAccount = { ...connected(), googleEnabledByAgency: false };
    await render(ReputationReviews);
    expect(byId("rep-reviews-gate-off")?.textContent).toContain("not enabled");
    expect(byId("stub-reviews")).toBeNull();
  });

  it.each([
    ["not connected", { ...connected(), googleConnectionMeta: null }],
    ["no listing", { ...connected(), googleListing: null }],
  ])("%s → points to AI Agents → Google Business", async (_l, sub) => {
    ctx.subAccount = sub;
    await render(ReputationReviews);
    expect(byId("rep-reviews-setup")?.querySelector("a")?.getAttribute("href")).toBe("/sa/sa1/ai-agents/google-business");
    expect(byId("stub-reviews")).toBeNull();
  });

  it("admin: the inbox with Sync and reply", async () => {
    await render(ReputationReviews);
    expect(byId("stub-reviews")).not.toBeNull();
    expect(seen.reviews.at(-1)).toEqual({ subAccountId: "sa1", canSync: true, reconnect: false });
  });

  it("member: read-only, and the deployment check is not even asked", async () => {
    ctx.isAdmin = false;
    await render(ReputationReviews);
    expect(seen.reviews.at(-1)).toEqual({ subAccountId: "sa1", canSync: false, reconnect: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("admin on a deployment without Google OAuth: reviews readable, no Sync/Reply that can only fail", async () => {
    configured = false;
    await render(ReputationReviews);
    expect(seen.reviews.at(-1)).toEqual({ subAccountId: "sa1", canSync: false, reconnect: false });
    expect(byId("rep-reviews-not-configured")?.textContent).toContain("Google isn't configured on this deployment");
  });

  it("admin while the deployment check is pending: loading, nothing offered yet", async () => {
    configured = "pending";
    await render(ReputationReviews);
    expect(byId("rep-reviews-loading")).not.toBeNull();
    expect(byId("stub-reviews")).toBeNull();
  });

  it("admin when the check itself fails: not blocked (the routes still refuse) — as on the Google Business page", async () => {
    configured = "fail";
    await render(ReputationReviews);
    expect(seen.reviews.at(-1)).toMatchObject({ canSync: true });
  });

  it("reconnect needed: cached reviews, labelled, no sync", async () => {
    ctx.subAccount = connected({ reconnectRequired: true });
    await render(ReputationReviews);
    expect(seen.reviews.at(-1)).toEqual({ subAccountId: "sa1", canSync: false, reconnect: true });
  });
});

describe("Widgets tab", () => {
  it("loading", async () => {
    ctx.loading = true;
    await render(ReputationWidgets);
    expect(byId("rep-widgets-loading")).not.toBeNull();
  });

  it("non-admin", async () => {
    ctx.isAdmin = false;
    await render(ReputationWidgets);
    expect(byId("rep-widgets-not-admin")).not.toBeNull();
    expect(byId("stub-widget")).toBeNull();
  });

  it("gate off with no widget", async () => {
    ctx.subAccount = { googleEnabledByAgency: false, gbpWidgetMeta: null };
    await render(ReputationWidgets);
    expect(byId("rep-widgets-gate-off")).not.toBeNull();
  });

  it("gate off WITH a widget still mounts it (Revoke stays reachable)", async () => {
    ctx.subAccount = { googleEnabledByAgency: false, gbpWidgetMeta: { publicId: "p" } };
    await render(ReputationWidgets);
    expect(byId("stub-widget")).not.toBeNull();
  });

  it("admin: the widget editor", async () => {
    await render(ReputationWidgets);
    expect(byId("rep-widgets")).not.toBeNull();
    expect(byId("stub-widget")).not.toBeNull();
  });
});

describe("Reputation → Settings (SP5 d2)", () => {
  const show = () => act(async () => root.render(createElement(ReputationSettings)));
  const id = (t: string) => container.querySelector(`[data-testid="${t}"]`);

  it("mounts the review-request settings for an admin", async () => {
    await show();
    expect(id("rep-settings")?.querySelector('[data-testid="stub-review-settings"]')).not.toBeNull();
  });

  it("tells a member they can't change them", async () => {
    ctx.isAdmin = false;
    await show();
    expect(id("rep-settings-not-admin")?.textContent).toContain("Only sub-account admins");
    expect(id("stub-review-settings")).toBeNull();
  });

  it("loading", async () => {
    ctx.loading = true;
    await show();
    expect(id("rep-settings-loading")).not.toBeNull();
  });
});
