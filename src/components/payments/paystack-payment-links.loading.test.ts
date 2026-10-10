// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While the workspace doc is still loading the Payments gate reads as off, so
 * the list must not claim "Locked by your agency" until it knows.
 */

const ctx = vi.hoisted(() => ({
  value: { subAccountId: "sa1", subAccount: null as Record<string, unknown> | null, loading: true },
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx.value }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "u1" }, loading: false }) }));
vi.mock("@/lib/firestore/payment-links", () => ({ subscribeToPaymentLinks: () => () => {} }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const { PaystackPaymentLinks } = await import("./paystack-payment-links");

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(PaystackPaymentLinks));
  });
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

describe("PaystackPaymentLinks gate", () => {
  it("shows a spinner, not Locked, while the workspace is loading", async () => {
    ctx.value = { subAccountId: "sa1", subAccount: null, loading: true };
    await render();
    expect(container.textContent).not.toContain("Locked by your agency");
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("shows Locked once loaded with Payments off", async () => {
    ctx.value = { subAccountId: "sa1", subAccount: { paymentsEnabledByAgency: false }, loading: false };
    await render();
    expect(container.textContent).toContain("Locked by your agency");
  });

  it("shows the form once loaded with Payments on and Paystack connected", async () => {
    ctx.value = {
      subAccountId: "sa1",
      subAccount: { paymentsEnabledByAgency: true, paystackConnectionMeta: { livemode: true } },
      loading: false,
    };
    await render();
    expect(container.textContent).not.toContain("Locked by your agency");
    expect(container.textContent).toContain("Create payment link");
  });
});
