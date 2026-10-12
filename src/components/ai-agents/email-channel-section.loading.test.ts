// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While the workspace doc is still loading the Email AI drafts gate reads as
 * off, so the section must not claim "locked" until it knows; once loaded it
 * reads its OWN gate (`emailAiDraftsEnabledByAgency`), not the email-domain one.
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

const { EmailChannelSection } = await import("./email-channel-section");

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(EmailChannelSection));
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

describe("EmailChannelSection gate", () => {
  it("shows a spinner, not locked, while the workspace is loading", async () => {
    setCtx(null, true);
    await render();
    expect(container.textContent).not.toContain("locked for this sub-account");
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("is locked once loaded with its gate off — the email-domain gate does not unlock it", async () => {
    setCtx({ emailDomainEnabledByAgency: true }, false);
    await render();
    expect(container.textContent).toContain("locked for this sub-account");
  });

  it("shows the settings, draft-only, once loaded with the gate on", async () => {
    setCtx({ emailAiDraftsEnabledByAgency: true }, false);
    await render();
    expect(container.textContent).not.toContain("locked for this sub-account");
    expect(container.textContent).toContain("Draft-only: nothing is ever emailed without a person approving it");
    expect(container.textContent).toContain("No mailbox is connected yet");
  });
});
