// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The widget card's Save names the widget its form was opened on, so a stale
 * form (opened before someone else created, rotated or revoked the widget)
 * is refused by the route instead of overwriting it — and says so in a toast.
 */

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
const ctx = vi.hoisted(() => ({ subAccountId: "sa1", isAdmin: true, loading: false, subAccount: {} as Record<string, unknown> }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));

import { WidgetSection } from "./widget-section";

const API = "/api/sub-accounts/sa1/gbp/widget";
const ID = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const META = { publicId: ID, enabled: true, allowedOrigins: ["https://www.velocityfibre.co.za"], maxReviews: 12, updatedAt: new Date() };
const CHANGED = "The widget changed since this page loaded. Reload to see it, then save again.";

let container: HTMLDivElement;
let root: Root;
let answer: { status: number; body: unknown };
const fetchMock = vi.fn();

beforeEach(async () => {
  toasts.error.mockReset();
  toasts.success.mockReset();
  answer = { status: 409, body: { code: "widget_changed", error: CHANGED } };
  fetchMock.mockReset().mockImplementation(async () => ({ ok: answer.status < 400, status: answer.status, json: async () => answer.body }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(createElement(WidgetSection)));
const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const save = () => act(async () => byId("gbp-widget-save")!.click());
const sent = () => JSON.parse(String((fetchMock.mock.calls.find(([u, i]) => u === API && i?.method === "PUT")![1] as RequestInit).body));

it("a 'create' form names no widget", async () => {
  ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: null };
  await render();
  await save();
  expect(sent().expectedPublicId).toBeNull();
});

it("an edit form names the widget it shows", async () => {
  ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: META };
  await render();
  await save();
  expect(sent().expectedPublicId).toBe(ID);
});

it("a refused stale save says so in a toast and changes nothing on the card", async () => {
  ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: null };
  await render();
  await save();
  expect(toasts.error).toHaveBeenCalledWith(CHANGED);
  expect(toasts.success).not.toHaveBeenCalled();
  expect(byId("gbp-widget-state-none")).not.toBeNull();
  expect(byId("gbp-widget-snippet")).toBeNull();
  expect(byId("gbp-widget-errors")).toBeNull();
});
