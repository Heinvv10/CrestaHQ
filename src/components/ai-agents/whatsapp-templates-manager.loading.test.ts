// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While the workspace doc is still loading the WhatsApp gate reads as off,
 * so the manager must not claim "WhatsApp is locked for this sub-account" until it knows.
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
vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  onSnapshot: vi.fn(() => () => {}),
  orderBy: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
}));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("@/lib/firestore/custom-fields", () => ({ subscribeToCustomFields: () => () => {} }));
vi.mock("@/components/ai-agents/whatsapp-template-buttons-editor", () => ({ WhatsappTemplateButtonsEditor: () => null }));

const { WhatsappTemplatesManager } = await import("./whatsapp-templates-manager");

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(WhatsappTemplatesManager));
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

describe("WhatsappTemplatesManager gate", () => {
  it("shows a spinner, not locked, while the workspace is loading", async () => {
    setCtx(null, true);
    await render();
    expect(container.textContent).not.toContain("WhatsApp is locked for this sub-account");
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("shows the locked state once loaded with the gate off", async () => {
    setCtx({ whatsappEnabledByAgency: false }, false);
    await render();
    expect(container.textContent).toContain("WhatsApp is locked for this sub-account");
  });

  it("shows the feature once loaded with the gate on", async () => {
    setCtx({ whatsappEnabledByAgency: true }, false);
    await render();
    expect(container.textContent).not.toContain("WhatsApp is locked for this sub-account");
    expect(container.textContent).toContain("Pre-approved messages");
  });
});
