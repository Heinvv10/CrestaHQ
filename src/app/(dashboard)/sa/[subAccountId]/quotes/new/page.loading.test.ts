// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While the workspace doc is still loading every payment rail reads as off,
 * so the invoice form must not claim "No payment method is connected" until
 * it knows.
 */

const NO_RAIL = "No payment method is connected for this workspace.";

const ctx = vi.hoisted(() => ({
  value: {
    subAccountId: "sa1",
    agencyId: "ag1",
    subAccount: null as Record<string, unknown> | null,
    saPath: (p: string) => `/sa/sa1${p}`,
    loading: true,
  },
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx.value }));
vi.mock("@/context/contacts-context", () => ({ useSubAccountContacts: () => ({ contacts: [] }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "u1" }, loading: false }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("kind=invoice"),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as never),
}));
vi.mock("@/lib/firestore/deals", () => ({ subscribeToDeals: () => () => {} }));
vi.mock("@/lib/firestore/products", () => ({ subscribeToProducts: () => () => {} }));
vi.mock("@/components/quotes/quote-builder", () => ({ QuoteBuilder: () => null }));

const { default: NewQuotePage } = await import("./page");

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(NewQuotePage));
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

describe("NewQuotePage payment banner", () => {
  it("does not claim no payment method while the workspace is loading", async () => {
    setCtx(null, true);
    await render();
    expect(container.textContent).toContain("New invoice");
    expect(container.textContent).not.toContain(NO_RAIL);
  });

  it("shows the banner once loaded with no rail connected", async () => {
    setCtx({ paymentsEnabledByAgency: true }, false);
    await render();
    expect(container.textContent).toContain(NO_RAIL);
  });

  it("hides the banner once loaded with a rail connected", async () => {
    setCtx({ paypalConfig: { username: "acme" } }, false);
    await render();
    expect(container.textContent).not.toContain(NO_RAIL);
  });
});
