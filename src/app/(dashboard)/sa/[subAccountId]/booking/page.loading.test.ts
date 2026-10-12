// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * isAdmin reads false until auth, workspace and memberships arrive, so the
 * list must not show the "Admin-only" badge, or pop admin buttons in late,
 * while it is still loading.
 */

const ctx = vi.hoisted(() => ({
  value: {
    loading: true,
    isAdmin: false,
    subAccountId: "sa1",
    saPath: (p: string) => `/sa/sa1${p}`,
  },
  pages: [] as unknown[],
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx.value }));
vi.mock("@/lib/firestore/booking-pages", () => ({
  subscribeToBookingPages: (_id: string, onNext: (list: unknown[]) => void) => {
    onNext(ctx.pages);
    return () => {};
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("sonner", () => ({ toast: { success: () => {}, error: () => {}, warning: () => {} } }));
vi.mock("@/components/booking/booking-help-dialog", () => ({ BookingHelpDialog: () => null }));
vi.mock("@/components/booking/default-booking-link-card", () => ({
  DefaultBookingLinkCard: () => "DEFAULT_LINK_CARD",
}));

const { default: BookingListPage } = await import("./page");

const PAGE = { id: "p1", slug: "intro", name: "Intro call", status: "published" };
const LOCK = "Admin-only";
const NEW = "New booking page";
const EMPTY = "Create your first booking page";
const CARD = "DEFAULT_LINK_CARD";

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(BookingListPage));
  });
}
const text = () => container.textContent ?? "";

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

describe("Booking list admin gate", () => {
  it("shows only the spinner while loading", async () => {
    ctx.value = { ...ctx.value, loading: true, isAdmin: false };
    ctx.pages = [PAGE];
    await render();
    for (const s of [LOCK, NEW, "Edit", "Duplicate", CARD]) {
      expect(text()).not.toContain(s);
    }
    expect(text()).toContain("Loading…");
  });

  it("holds admin buttons back while loading even if isAdmin is already true", async () => {
    ctx.value = { ...ctx.value, loading: true, isAdmin: true };
    ctx.pages = [PAGE];
    await render();
    for (const s of [LOCK, NEW, "Edit", "Duplicate", CARD]) {
      expect(text()).not.toContain(s);
    }
    expect(text()).toContain("Loading…");
  });

  it("shows the Admin-only badge and no admin buttons for a loaded non-admin", async () => {
    ctx.value = { ...ctx.value, loading: false, isAdmin: false };
    ctx.pages = [PAGE];
    await render();
    expect(text()).toContain(LOCK);
    expect(text()).toContain("Intro call");
    expect(text()).not.toContain("Edit");
    expect(text()).not.toContain("Duplicate");
  });

  it("shows the admin buttons and the link card for a loaded admin", async () => {
    ctx.value = { ...ctx.value, loading: false, isAdmin: true };
    ctx.pages = [PAGE];
    await render();
    for (const s of [NEW, "Edit", "Duplicate", CARD]) {
      expect(text()).toContain(s);
    }
    expect(text()).not.toContain(LOCK);
  });

  it("hides the empty state while loading", async () => {
    ctx.value = { ...ctx.value, loading: true, isAdmin: false };
    ctx.pages = [];
    await render();
    expect(text()).not.toContain(EMPTY);
    expect(text()).not.toContain(NEW);
  });
});
