// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * "Re-check card charge": one click posts to the re-check route — no
 * confirm() dialog — and hands its parent what Paystack answered, or why it
 * failed.
 */

const { RecheckCardChargeButton } = await import("./recheck-card-charge-button");

const fetchMock = vi.fn();
const confirmMock = vi.fn(() => true);
const onMessage = vi.fn();
const onError = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", confirmMock);
  fetchMock.mockReset();
  confirmMock.mockClear();
  onMessage.mockClear();
  onError.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(RecheckCardChargeButton, { subAccountId: "sa1", invoiceId: "inv1", onMessage, onError })));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const click = () =>
  act(async () => {
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Re-check card charge"))!.click();
  });

it("posts to the re-check route without a confirm() and shows the outcome", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ outcome: "declined" }), { status: 200 }));
  await click();
  expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/quotes/inv1/recheck-card-charge", { method: "POST" });
  expect(confirmMock).not.toHaveBeenCalled();
  expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("did not go through"), "declined");
  expect(onError).not.toHaveBeenCalled();
});

it("shows the route's refusal", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ error: "The Paystack key changed since this charge; check your Paystack dashboard." }), {
      status: 409,
    }),
  );
  await click();
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("The Paystack key changed since this charge"));
  expect(onMessage).not.toHaveBeenCalled();
});
