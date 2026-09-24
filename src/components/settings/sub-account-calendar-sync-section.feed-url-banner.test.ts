// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

/**
 * PR #219 (2026-09-24) minted a per-user token into the "All bookings"
 * calendar feed URL, which silently broke every subscription a member had
 * already added to their external calendar app — the URL just stops
 * updating, with no error visible anywhere the member would look. This
 * covers the one-time banner that tells them to re-copy the URL: it shows
 * until dismissed, stays dismissed (per browser), and auto-hides after the
 * cutover window closes.
 */

vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccountId: "sa_1" }),
}));
vi.mock("@/components/settings/google-calendar-card", () => ({
  GoogleCalendarCard: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
  feedUrlChangeBannerStillActive,
  SubAccountCalendarSyncSection,
} from "./sub-account-calendar-sync-section";

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ url: "https://example.com/feed.ics" }),
    })),
  );
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(createElement(SubAccountCalendarSyncSection));
  });
  cleanup = async () => {
    await act(async () => root.unmount());
    el.remove();
  };
  return {
    banner: () => el.querySelector('[data-testid="feed-url-change-banner"]'),
  };
}

it("shows the feed-URL-change banner by default", async () => {
  const m = await mount();
  expect(m.banner()).not.toBeNull();
  expect(m.banner()?.textContent).toContain("24 September 2026");
});

it("dismissing it hides it and persists the dismissal", async () => {
  const m = await mount();
  const dismissButton = m.banner()!.querySelector("button")!;
  await act(async () => dismissButton.click());
  expect(m.banner()).toBeNull();
  expect(localStorage.getItem("cal-feed-url-change-2026-09-24-dismissed")).toBe(
    "1",
  );
});

it("does not show again after a prior dismissal", async () => {
  localStorage.setItem("cal-feed-url-change-2026-09-24-dismissed", "1");
  const m = await mount();
  expect(m.banner()).toBeNull();
});

it("auto-hides after 2026-11-01", () => {
  expect(feedUrlChangeBannerStillActive(new Date("2026-10-31T23:59:59Z"))).toBe(
    true,
  );
  expect(feedUrlChangeBannerStillActive(new Date("2026-11-01T00:00:00Z"))).toBe(
    false,
  );
  expect(feedUrlChangeBannerStillActive(new Date("2027-01-01T00:00:00Z"))).toBe(
    false,
  );
});
