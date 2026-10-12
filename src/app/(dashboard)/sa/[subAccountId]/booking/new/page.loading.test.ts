// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * isAdmin reads false until auth, workspace and memberships arrive, so the
 * page must not tell an admin "admin only" while it is still loading.
 */

const ctx = vi.hoisted(() => ({
  value: {
    loading: true,
    isAdmin: false,
    saPath: (p: string) => `/sa/sa1${p}`,
  },
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx.value }));
vi.mock("@/components/booking/booking-page-editor", () => ({ BookingPageEditor: () => null }));

const { default: NewBookingPagePage } = await import("./page");

const LOCK = "Booking pages are sub-account admin only";
const PICKER = "Choose calendar type";

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(NewBookingPagePage));
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

describe("New booking page admin gate", () => {
  it("shows a spinner, not the lock or the picker, while loading", async () => {
    ctx.value = { ...ctx.value, loading: true, isAdmin: false };
    await render();
    expect(container.textContent).not.toContain(LOCK);
    expect(container.textContent).not.toContain(PICKER);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("shows the lock once loaded for a non-admin", async () => {
    ctx.value = { ...ctx.value, loading: false, isAdmin: false };
    await render();
    expect(container.textContent).toContain(LOCK);
    expect(container.textContent).not.toContain(PICKER);
  });

  it("shows the picker once loaded for an admin", async () => {
    ctx.value = { ...ctx.value, loading: false, isAdmin: true };
    await render();
    expect(container.textContent).toContain(PICKER);
    expect(container.textContent).not.toContain(LOCK);
  });
});
