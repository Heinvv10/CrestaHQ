// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetSection } from "./widget-section";

/**
 * Every state of the public-reviews widget card, rendered for real (jsdom)
 * from the live sub-account doc; only `fetch`, the clipboard and the context
 * are stubbed.
 */

const ctx = vi.hoisted(() => ({
  subAccountId: "sa1",
  isAdmin: true,
  loading: false,
  subAccount: {} as Record<string, unknown>,
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));

const API = "/api/sub-accounts/sa1/gbp/widget";
const ID = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const META = { publicId: ID, enabled: true, allowedOrigins: ["https://www.velocityfibre.co.za"], maxReviews: 12, updatedAt: new Date() };

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
let routes: Record<string, (init?: RequestInit) => unknown>;
const writeText = vi.fn(async () => {});

beforeEach(() => {
  ctx.isAdmin = true;
  ctx.loading = false;
  ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: null };
  process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.test";
  routes = {
    [`PUT ${API}`]: (init) => json({ widget: { ...META, ...JSON.parse(String(init?.body)), updatedAt: "2026-09-11T00:00:00.000Z" } }),
    [`POST ${API}/rotate`]: () => json({ widget: { ...META, publicId: "Z".repeat(32) } }),
    [`DELETE ${API}`]: () => json({ ok: true }),
  };
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const handler = routes[`${init?.method ?? "GET"} ${url}`];
    if (!handler) throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
    return handler(init);
  });
  writeText.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("alert", vi.fn());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  expect(window.confirm).not.toHaveBeenCalled();
  expect(window.alert).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(createElement(WidgetSection)));
}
const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function click(el: Element | null) {
  if (!el) throw new Error(`no element in: ${container.textContent}`);
  await act(async () => (el as HTMLElement).click());
}
async function clickText(label: string) {
  await click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) ?? null);
}
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const calls = (method: string, url: string) =>
  fetchMock.mock.calls.filter(([u, i]) => u === url && ((i as RequestInit | undefined)?.method ?? "GET") === method);

describe("who sees what", () => {
  it("renders nothing for a non-admin", async () => {
    ctx.isAdmin = false;
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: META };
    await render();
    expect(byId("gbp-widget-card")).toBeNull();
  });

  it("renders nothing while loading", async () => {
    ctx.loading = true;
    await render();
    expect(byId("gbp-widget-card")).toBeNull();
  });

  it("renders nothing with the gate off and no widget", async () => {
    ctx.subAccount = { googleEnabledByAgency: false };
    await render();
    expect(byId("gbp-widget-card")).toBeNull();
  });

  it("with the gate off keeps ONLY Revoke for an existing widget — and it works", async () => {
    ctx.subAccount = { googleEnabledByAgency: false, gbpWidgetMeta: META };
    await render();
    expect(byId("gbp-widget-card")).not.toBeNull();
    expect(byId("gbp-widget-save")).toBeNull();
    expect(byId("gbp-widget-rotate")).toBeNull();
    expect(byId("gbp-widget-snippet")).toBeNull();
    await click(byId("gbp-widget-revoke"));
    expect(calls("DELETE", API)).toHaveLength(0);
    await clickText("Yes, revoke");
    expect(calls("DELETE", API)).toHaveLength(1);
  });
});

describe("creating a widget", () => {
  it("starts enabled with no origins and 12 reviews, and saves exactly that config", async () => {
    await render();
    expect(byId("gbp-widget-state-none")).not.toBeNull();
    expect(byId("gbp-widget-snippet")).toBeNull();
    expect(byId("gbp-widget-rotate")).toBeNull();
    const origins = byId("gbp-widget-origins") as HTMLTextAreaElement;
    await type(origins, "https://www.velocityfibre.co.za\n\n  http://127.0.0.1:4401 \n");
    await click(byId("gbp-widget-save"));
    const [, init] = calls("PUT", API)[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      enabled: true,
      allowedOrigins: ["https://www.velocityfibre.co.za", "http://127.0.0.1:4401"],
      maxReviews: 12,
    });
    // No rating filter is offered, anywhere.
    expect(container.textContent?.toLowerCase()).not.toMatch(/min(imum)? rating|only show|positive/);
  });

  it("shows the server's reason next to each rejected origin", async () => {
    routes[`PUT ${API}`] = () =>
      json({ error: "Some allowed origins are not valid.", code: "invalid_origins", details: [{ index: 0, value: "http://www.velocityfibre.co.za", reason: "https_required" }] }, 400);
    await render();
    await type(byId("gbp-widget-origins") as HTMLTextAreaElement, "http://www.velocityfibre.co.za");
    await click(byId("gbp-widget-save"));
    const errors = byId("gbp-widget-errors");
    expect(errors?.textContent).toContain("http://www.velocityfibre.co.za");
    expect(errors?.textContent).toContain("must use https");
  });

  it("shows a plain error for any other refusal", async () => {
    routes[`PUT ${API}`] = () => json({ error: "maxReviews must be a whole number from 1 to 50.", code: "invalid_body" }, 400);
    await render();
    await click(byId("gbp-widget-save"));
    expect(byId("gbp-widget-errors")?.textContent).toContain("maxReviews must be a whole number from 1 to 50.");
  });
});

describe("an existing widget", () => {
  beforeEach(() => {
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: META, googleListing: { mapsUri: "https://maps.google.com/?cid=1" } };
  });

  it("prefills the form and shows the copy-paste snippet with the real id and app URL, and the feed URL", async () => {
    await render();
    expect((byId("gbp-widget-enable") as HTMLInputElement).checked).toBe(true);
    expect((byId("gbp-widget-origins") as HTMLTextAreaElement).value).toBe("https://www.velocityfibre.co.za");
    const snippet = byId("gbp-widget-snippet")!.textContent ?? "";
    expect(snippet).toContain(`data-crestahq-reviews="${ID}"`);
    expect(snippet).toContain(`data-api="https://crm.example.test"`);
    expect(snippet).toContain(`<script src="https://crm.example.test/embed/gbp-reviews.js" defer></script>`);
    expect(snippet).toContain("https://maps.google.com/?cid=1");
    expect(byId("gbp-widget-feed-url")?.textContent).toBe(`https://crm.example.test/api/public/gbp/feed/${ID}`);
    await clickText("Copy snippet");
    expect(writeText).toHaveBeenCalledWith(snippet);
  });

  it("says when the widget is switched off", async () => {
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: { ...META, enabled: false } };
    await render();
    expect(byId("gbp-widget-state-disabled")).not.toBeNull();
  });

  it("disabling it saves enabled:false", async () => {
    await render();
    await click(byId("gbp-widget-enable"));
    await click(byId("gbp-widget-save"));
    expect(JSON.parse(String((calls("PUT", API)[0][1] as RequestInit).body))).toMatchObject({ enabled: false });
  });

  it("rotates only after an inline confirm", async () => {
    await render();
    await click(byId("gbp-widget-rotate"));
    expect(calls("POST", `${API}/rotate`)).toHaveLength(0);
    await clickText("Yes, rotate");
    expect(calls("POST", `${API}/rotate`)).toHaveLength(1);
  });

  it("revokes only after an inline confirm", async () => {
    await render();
    await click(byId("gbp-widget-revoke"));
    expect(calls("DELETE", API)).toHaveLength(0);
    await clickText("Yes, revoke");
    expect(calls("DELETE", API)).toHaveLength(1);
  });
});
