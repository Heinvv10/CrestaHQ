// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The widget card's Save names the newest widget this page knows of — the
 * live doc's, or the answer of this page's own create / rotate / revoke —
 * so a stale form (opened before someone else changed the widget) is
 * refused by the route instead of overwriting it, and says so in a toast,
 * while this page's own second Save before its snapshot is not.
 */

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
const ctx = vi.hoisted(() => ({ subAccountId: "sa1", isAdmin: true, loading: false, subAccount: {} as Record<string, unknown> }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));

import { WidgetSection } from "./widget-section";

const API = "/api/sub-accounts/sa1/gbp/widget";
const ID = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const NEW = "N".repeat(32);
const ROTATED = "R".repeat(32);
const META = { publicId: ID, enabled: true, allowedOrigins: ["https://www.velocityfibre.co.za"], maxReviews: 12, updatedAt: new Date() };
const CHANGED = "The widget changed since this page loaded. Reload to see it, then save again.";

let container: HTMLDivElement;
let root: Root;
/** The route, in miniature: the stored widget id, and the expectation check. */
let stored: string | null;
const fetchMock = vi.fn();
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

beforeEach(async () => {
  toasts.error.mockReset();
  toasts.success.mockReset();
  stored = null;
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === API && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      if (body.expectedPublicId !== undefined && body.expectedPublicId !== stored) return reply(409, { code: "widget_changed", error: CHANGED });
      stored = stored ?? NEW;
      return reply(200, { widget: { ...META, publicId: stored } });
    }
    if (url === `${API}/rotate`) return reply(200, { widget: { ...META, publicId: (stored = ROTATED) } });
    if (url === API && init?.method === "DELETE") return reply(200, { ok: !(stored = null) });
    throw new Error(`unexpected fetch ${init?.method} ${url}`);
  });
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
const clickText = (label: string) =>
  act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)!.click());
const save = () => act(async () => byId("gbp-widget-save")!.click());
const puts = () =>
  fetchMock.mock.calls.filter(([u, i]) => u === API && i?.method === "PUT").map(([, i]) => JSON.parse(String((i as RequestInit).body)));
/** No snapshot ever arrives in these tests unless one is rendered: ctx.subAccount stays as set. */
const withWidget = (meta: unknown) => (ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: meta });

it("a 'create' form names no widget", async () => {
  withWidget(null);
  await render();
  await save();
  expect(puts()[0].expectedPublicId).toBeNull();
});

it("an edit form names the widget it shows", async () => {
  withWidget(META);
  stored = ID;
  await render();
  await save();
  expect(puts()[0].expectedPublicId).toBe(ID);
  expect(toasts.error).not.toHaveBeenCalled();
});

it("a stale 'create' is refused with a toast and changes nothing on the card", async () => {
  withWidget(null);
  stored = ID; // someone else created it; this page has not had the snapshot
  await render();
  await save();
  expect(toasts.error).toHaveBeenCalledWith(CHANGED);
  expect(toasts.success).not.toHaveBeenCalled();
  expect(byId("gbp-widget-state-none")).not.toBeNull();
  expect(byId("gbp-widget-snippet")).toBeNull();
  expect(byId("gbp-widget-errors")).toBeNull();
});

it("this page's own create, then a second Save before any snapshot, is not refused", async () => {
  withWidget(null);
  await render();
  await save();
  await save();
  expect(puts().map((b) => b.expectedPublicId)).toEqual([null, NEW]);
  expect(toasts.error).not.toHaveBeenCalled();
  expect(toasts.success).toHaveBeenCalledTimes(2);
});

it("this page's own rotate, then a Save before any snapshot, is not refused", async () => {
  withWidget(META);
  stored = ID;
  await render();
  await clickText("Rotate id");
  await clickText("Yes, rotate");
  await save();
  expect(puts().map((b) => b.expectedPublicId)).toEqual([ROTATED]);
  expect(toasts.error).not.toHaveBeenCalled();
});

it("this page's own revoke, then a Save before any snapshot, creates afresh", async () => {
  withWidget(META);
  stored = ID;
  await render();
  await clickText("Revoke widget");
  await clickText("Yes, revoke");
  await save();
  expect(puts().map((b) => b.expectedPublicId)).toEqual([null]);
  expect(toasts.error).not.toHaveBeenCalled();
});

it("a snapshot of someone else's rotate is the widget the next Save names", async () => {
  withWidget(META);
  stored = ROTATED;
  await render();
  withWidget({ ...META, publicId: ROTATED });
  await render();
  await save();
  expect(puts().map((b) => b.expectedPublicId)).toEqual([ROTATED]);
  expect(toasts.error).not.toHaveBeenCalled();
});
