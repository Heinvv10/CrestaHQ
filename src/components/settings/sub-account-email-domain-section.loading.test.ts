// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While the workspace doc is still loading the sending-domain gate reads as off,
 * so the section must not claim "Disabled by your agency" until it knows.
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

const { SubAccountEmailDomainSection } = await import("./sub-account-email-domain-section");

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(SubAccountEmailDomainSection));
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

describe("SubAccountEmailDomainSection gate", () => {
  it("does not show locked while the workspace is loading", async () => {
    setCtx(null, true);
    await render();
    expect(container.textContent).not.toContain("Disabled by your agency");
  });

  it("shows the locked state once loaded with the gate off", async () => {
    setCtx({ emailDomainEnabledByAgency: false }, false);
    await render();
    expect(container.textContent).toContain("Disabled by your agency");
  });

  it("shows the feature once loaded with the gate on", async () => {
    setCtx({ emailDomainEnabledByAgency: true, replyToEmail: "a@b.co" }, false);
    await render();
    expect(container.textContent).not.toContain("Disabled by your agency");
    expect(container.textContent).toContain("Sending subdomain");
  });
});
