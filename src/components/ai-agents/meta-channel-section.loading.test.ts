// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While the workspace doc is still loading the Messenger & Instagram gate reads as off,
 * so the section must not claim "is locked for this sub-account" until it knows.
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
vi.mock("@/components/ai-agents/model-override-select", () => ({ ModelOverrideSelect: () => null }));

const { MetaChannelSection } = await import("./meta-channel-section");

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(MetaChannelSection));
  });
}

function setCtx(subAccount: Record<string, unknown> | null, loading: boolean) {
  ctx.value = { ...ctx.value, subAccount, loading };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("MetaChannelSection gate", () => {
  it("shows a spinner, not locked, while the workspace is loading", async () => {
    setCtx(null, true);
    await render();
    expect(container.textContent).not.toContain("is locked for this sub-account");
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("shows the locked state once loaded with the gate off", async () => {
    setCtx({ metaInboxEnabledByAgency: false }, false);
    await render();
    expect(container.textContent).toContain("is locked for this sub-account");
  });

  it("shows the feature once loaded with the gate on", async () => {
    setCtx({ metaInboxEnabledByAgency: true, metaAgentEnabledByAgency: true }, false);
    await render();
    expect(container.textContent).not.toContain("is locked for this sub-account");
    expect(container.textContent).toContain("One switch covers both platforms");
  });
});
