// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While the workspace doc is still loading the Community gate reads as off,
 * so the page must not claim "Community is locked" until it knows.
 */

const ctx = vi.hoisted(() => ({
  value: {
    subAccountId: "sa1",
    subAccount: null as Record<string, unknown> | null,
    isAdmin: true,
    loading: true,
  },
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx.value }));
const groups = vi.hoisted(() => ({ emitNow: true }));
vi.mock("@/lib/firestore/community-groups", () => ({
  subscribeToCommunityGroups: (_id: string, onData: (l: unknown[]) => void) => {
    if (groups.emitNow) onData([]);
    return () => {};
  },
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const { default: CommunityPage } = await import("./page");

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(CommunityPage));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  groups.emitNow = true;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("CommunityPage gate", () => {
  it("shows a spinner, not locked, while the workspace is loading", async () => {
    ctx.value = { subAccountId: "sa1", subAccount: null, isAdmin: true, loading: true };
    await render();
    expect(container.textContent).not.toContain("Community is locked");
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("shows locked once loaded with Community off", async () => {
    ctx.value = { subAccountId: "sa1", subAccount: { communityEnabledByAgency: false }, isAdmin: true, loading: false };
    await render();
    expect(container.textContent).toContain("Community is locked");
  });

  it("shows the groups page once loaded with Community on", async () => {
    ctx.value = { subAccountId: "sa1", subAccount: { communityEnabledByAgency: true }, isAdmin: true, loading: false };
    await render();
    expect(container.textContent).not.toContain("Community is locked");
    expect(container.textContent).toContain("Skool-style groups");
  });

  it("does not claim 'No groups yet' between the doc arriving and the first snapshot", async () => {
    groups.emitNow = false;
    ctx.value = { subAccountId: "sa1", subAccount: null, isAdmin: true, loading: true };
    await render();
    ctx.value = { subAccountId: "sa1", subAccount: { communityEnabledByAgency: true }, isAdmin: true, loading: false };
    await render();
    expect(container.textContent).not.toContain("No groups yet");
  });
});
