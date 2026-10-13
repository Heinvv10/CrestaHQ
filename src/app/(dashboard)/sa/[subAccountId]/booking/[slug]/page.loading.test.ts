// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * isAdmin reads false until auth, workspace and memberships arrive, so the
 * editor slot must not show "Admin-only editor" to an admin while loading.
 * The booking page itself is already loaded in every case here.
 */

const ctx = vi.hoisted(() => ({
  value: {
    subAccountId: "sa1",
    loading: true,
    isAdmin: false,
    saPath: (p: string) => `/sa/sa1${p}`,
  },
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx.value }));
vi.mock("next/navigation", () => ({ useParams: () => ({ subAccountId: "sa1", slug: "intro" }) }));
vi.mock("@/lib/firestore/booking-pages", () => ({
  subscribeToBookingPage: (_sa: string, slug: string, onNext: (p: unknown) => void) => {
    onNext({ slug, name: "Intro call", status: "draft" });
    return () => {};
  },
  subscribeToBookingPageEvents: () => () => {},
}));
vi.mock("@/components/booking/booking-page-editor", () => ({
  BookingPageEditor: () => createElement("p", null, "EDITOR"),
}));
vi.mock("@/components/booking/booking-embed-dialog", () => ({ BookingEmbedDialog: () => null }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const { default: EditBookingPagePage } = await import("./page");

const LOCK = "Admin-only editor";
const EDITOR = "EDITOR";

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(EditBookingPagePage));
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

describe("Edit booking page admin gate", () => {
  it("shows the loaded page with a spinner, not the lock or the editor, while loading", async () => {
    ctx.value = { ...ctx.value, loading: true, isAdmin: false };
    await render();
    expect(container.textContent).toContain("Intro call");
    expect(container.textContent).not.toContain(LOCK);
    expect(container.textContent).not.toContain(EDITOR);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("shows the lock once loaded for a non-admin", async () => {
    ctx.value = { ...ctx.value, loading: false, isAdmin: false };
    await render();
    expect(container.textContent).toContain(LOCK);
    expect(container.textContent).not.toContain(EDITOR);
  });

  it("shows the editor once loaded for an admin", async () => {
    ctx.value = { ...ctx.value, loading: false, isAdmin: true };
    await render();
    expect(container.textContent).toContain(EDITOR);
    expect(container.textContent).not.toContain(LOCK);
  });
});
