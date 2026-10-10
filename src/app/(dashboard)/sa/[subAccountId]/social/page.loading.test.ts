// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While the workspace doc is still loading the Social Planner gate reads as off,
 * so the page must not claim "Social Planner is locked by your agency" until it knows.
 */

const ctx = vi.hoisted(() => ({
  value: {
    subAccountId: "sa1",
    subAccount: null as Record<string, unknown> | null,
    isAdmin: true,
    saPath: (p: string) => `/sa/sa1${p}`,
    loading: true,
  },
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx.value }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/firestore/social-posts", () => ({ subscribeToSocialPosts: () => () => {} }));
vi.mock("@/components/social/social-content-calendar", () => ({ SocialContentCalendar: () => null }));
vi.mock("@/components/social/social-post-composer", () => ({ SocialPostComposer: () => null }));
vi.mock("@/components/social/social-connections", () => ({ SocialConnections: () => null }));

const { default: SocialPlannerPage } = await import("./page");

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(SocialPlannerPage));
  });
}

function setCtx(subAccount: Record<string, unknown> | null, loading: boolean) {
  ctx.value = { ...ctx.value, subAccount, loading };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("SocialPlannerPage gate", () => {
  it("shows a spinner, not locked, while the workspace is loading", async () => {
    setCtx(null, true);
    await render();
    expect(container.textContent).not.toContain("Social Planner is locked by your agency");
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("shows the locked state once loaded with the gate off", async () => {
    setCtx({ socialPlannerEnabledByAgency: false }, false);
    await render();
    expect(container.textContent).toContain("Social Planner is locked by your agency");
  });

  it("shows the feature once loaded with the gate on", async () => {
    setCtx({ socialPlannerEnabledByAgency: true }, false);
    await render();
    expect(container.textContent).not.toContain("Social Planner is locked by your agency");
    expect(container.textContent).toContain("New post");
  });
});
