// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While the workspace doc is still loading the Labs gate reads as off,
 * so the page must not claim "Labs is locked" until it knows.
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
vi.mock("@/components/labs/watchdog-section", () => ({ WatchdogSection: () => null }));
vi.mock("@/components/labs/funnels-section", () => ({ FunnelsSection: () => null }));

const { default: LabsPage } = await import("./page");

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(LabsPage));
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

describe("LabsPage gate", () => {
  it("shows a spinner, not locked, while the workspace is loading", async () => {
    setCtx(null, true);
    await render();
    expect(container.textContent).not.toContain("Labs is locked");
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("shows the locked state once loaded with the gate off", async () => {
    setCtx({ labsEnabledByAgency: false }, false);
    await render();
    expect(container.textContent).toContain("Labs is locked");
  });

  it("shows the feature once loaded with the gate on", async () => {
    setCtx({ labsEnabledByAgency: true }, false);
    await render();
    expect(container.textContent).not.toContain("Labs is locked");
    expect(container.textContent).toContain("Pre-release");
  });
});
