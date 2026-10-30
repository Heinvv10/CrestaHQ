// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The tracking card shows the live doc's switches (off when absent), PATCHes
 * only the kind that was clicked, says when the save was refused, and is
 * hidden from non-admins.
 */

const ctx = vi.hoisted(() => ({
  subAccountId: "sa1",
  isAdmin: true,
  subAccount: null as null | { emailTracking?: { opens?: boolean; clicks?: boolean } },
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const { SubAccountEmailTrackingSection } = await import("./sub-account-email-tracking-section");

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  ctx.isAdmin = true;
  ctx.subAccount = null;
  toast.success.mockReset();
  toast.error.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no PointerEvent; the checkbox primitive dispatches one.
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(createElement(SubAccountEmailTrackingSection)));
const box = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
const checked = (label: string) => box(label).getAttribute("aria-checked");

it("shows both switches off when the sub-account never set them", async () => {
  await render();
  expect(checked("Track opens (estimate)")).toBe("false");
  expect(checked("Track link clicks")).toBe("false");
  expect(container.textContent).toContain("POPIA");
});

it("reflects the live doc and PATCHes only the kind clicked", async () => {
  ctx.subAccount = { emailTracking: { opens: true } };
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  await render();
  expect(checked("Track opens (estimate)")).toBe("true");
  await act(async () => box("Track link clicks").click());
  expect(fetchMock).toHaveBeenCalledWith("/api/agency/sub-accounts/sa1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emailTracking: { clicks: true } }),
  });
  expect(toast.success).toHaveBeenCalled();
});

it("shows a refused save instead of swallowing it", async () => {
  fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "Sub-account admin only" }) });
  await render();
  await act(async () => box("Track opens (estimate)").click());
  expect(toast.error).toHaveBeenCalledWith("Sub-account admin only");
});

it("renders nothing for a non-admin", async () => {
  ctx.isAdmin = false;
  await render();
  expect(container.innerHTML).toBe("");
});
