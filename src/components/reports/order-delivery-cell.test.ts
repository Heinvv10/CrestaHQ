// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Order } from "@/types/orders";

/**
 * Reports → Payments, delivery cell: shows what the delivery did, and the
 * admin-only "Re-send delivery" button posts to the redeliver route for an
 * order that is owed a delivery, and only for one.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const { OrderDeliveryCell } = await import("./order-delivery-cell");
const { toast } = await import("sonner");

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

const order = (over: Partial<Order> = {}) =>
  ({
    id: "ord1",
    source: "product_link",
    status: "paid",
    deliveries: [{ productId: "p1", delivery: { type: "download", url: "https://files.example.com/a.pdf" } }],
    ...over,
  }) as unknown as Order;

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

const render = (o: Order, canManage = true) =>
  act(async () => root.render(createElement(OrderDeliveryCell, { order: o, subAccountId: "sa1", canManage })));
const button = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === "Re-send delivery");

const answer = (body: Record<string, unknown>) =>
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, ...body }) });
const resendAndRead = async () => {
  await render(order());
  await act(async () => button()!.click());
  return container.textContent ?? "";
};

it("an admin re-sends: POSTs the order's redeliver route and says so", async () => {
  answer({ delivered: 1, failed: 0, skipped: 0 });
  const text = await resendAndRead();

  expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/orders/ord1/redeliver", { method: "POST" });
  expect(text).toContain("Delivery re-sent.");
  expect(toast.success).toHaveBeenCalledWith("Delivery re-sent.");
  expect(toast.error).not.toHaveBeenCalled();
});

it("a 200 where nothing ran (in progress, or revoked) does NOT say it was re-sent", async () => {
  answer({ delivered: 0, failed: 0, skipped: 1 });
  const text = await resendAndRead();

  expect(text).toContain("Nothing was sent: a delivery is already in progress, or this order's access was revoked.");
  expect(text).not.toContain("Delivery re-sent.");
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Nothing was sent"));
  expect(toast.success).not.toHaveBeenCalled();
});

it("a 200 where the delivery failed again says so, not that it was re-sent", async () => {
  answer({ delivered: 0, failed: 1, skipped: 0 });
  const text = await resendAndRead();

  expect(text).toContain("a delivery failed again");
  expect(text).not.toContain("Delivery re-sent.");
  expect(text).not.toContain("Nothing was sent");
});

it("shows the failure message the delivery recorded", async () => {
  await render(order({ deliveryStatus: { state: "failed", error: "This buyer is banned from the group, so access wasn't granted.", at: 1 } }));
  expect(container.textContent).toContain("Delivery failed: This buyer is banned from the group");
  expect(button()).toBeTruthy();
});

it("shows Delivered once the delivery is done", async () => {
  await render(order({ deliveryStatus: { state: "done", error: null, at: 1 } }));
  expect(container.textContent).toContain("Delivered");
});

it("no button for a non-admin", async () => {
  await render(order(), false);
  expect(button()).toBeUndefined();
});

it.each([
  ["a refunded order", { status: "refunded" }],
  ["a pending order", { status: "pending" }],
  ["a held order", { status: "pending", heldAt: new Date() }],
  ["a flagged order", { attention: "Needs a look.", attentionOpen: true }],
] as const)("no button for %s", async (_name, over) => {
  await render(order(over as Partial<Order>));
  expect(button()).toBeUndefined();
});

it("renders nothing for an order with nothing to deliver", async () => {
  await render(order({ deliveries: [] }));
  expect(container.textContent).toBe("");
  await render(order({ source: "checkout_page", deliveryStatus: { state: "failed", error: "x", at: 1 } }));
  expect(container.textContent).toBe("");
});

it("a refusal from the route is not shown as success", async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Only paid orders can be delivered." }) });
  await render(order());
  await act(async () => button()!.click());
  expect(container.textContent).not.toContain("Delivery re-sent.");
});
