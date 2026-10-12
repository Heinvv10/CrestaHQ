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
      layout: "carousel",
      theme: "light",
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

  it("tells the admin how fast changes reach visitors: settings ~1 min, synced reviews ~2 min", async () => {
    await render();
    const text = byId("gbp-widget-card")?.textContent ?? "";
    expect(text).toContain("Settings changes reach visitors within about a minute");
    expect(text).toContain("newly synced reviews within about two minutes");
  });

  it("HTML-escapes the publicId it pastes into the snippet", async () => {
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: { ...META, publicId: 'x"<y>&z' } };
    await render();
    const snippet = byId("gbp-widget-snippet")!.textContent ?? "";
    expect(snippet).toContain('data-crestahq-reviews="x&quot;&lt;y&gt;&amp;z"');
    expect(snippet).not.toContain('x"<y>');
  });

  it("puts only an http(s) Maps link in the snippet, normalised and HTML-escaped", async () => {
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: META, googleListing: { mapsUri: 'https://maps.google.com/?q="<b>&x' } };
    await render();
    const snippet = byId("gbp-widget-snippet")!.textContent ?? "";
    // URL serialisation percent-encodes " < > in the query; & is escaped for HTML.
    expect(snippet).toContain('href="https://maps.google.com/?q=%22%3Cb%3E&amp;x"');
    expect(snippet).not.toContain('"<b>');
  });

  it("HTML-escapes every value it pastes into the snippet", async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://crm.example.test/a"<b>&c';
    await render();
    const snippet = byId("gbp-widget-snippet")!.textContent ?? "";
    expect(snippet).toContain('data-api="https://crm.example.test/a&quot;&lt;b&gt;&amp;c"');
    expect(snippet).not.toContain('a"<b>');
  });

  it("falls back to the generic Maps link for a non-http(s) mapsUri", async () => {
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: META, googleListing: { mapsUri: "javascript:alert(1)" } };
    await render();
    const snippet = byId("gbp-widget-snippet")!.textContent ?? "";
    expect(snippet).not.toContain("javascript:");
    expect(snippet).toContain('href="https://www.google.com/maps"');
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

// Firestore's Listen stream can sit silent for ~30 s after a write: every
// change shows from the route's 200, and the next snapshot takes over.
describe("without waiting for the live doc", () => {
  it("a created widget shows its snippet from the 200", async () => {
    await render();
    await type(byId("gbp-widget-origins") as HTMLTextAreaElement, "https://www.velocityfibre.co.za");
    await click(byId("gbp-widget-save"));
    expect(byId("gbp-widget-state-none")).toBeNull();
    expect(byId("gbp-widget-snippet")?.textContent).toContain(`data-crestahq-reviews="${ID}"`);
    expect((byId("gbp-widget-origins") as HTMLTextAreaElement).value).toBe("https://www.velocityfibre.co.za");
  });

  it("switching a widget off reads as off from the 200", async () => {
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: META };
    await render();
    await click(byId("gbp-widget-enable"));
    await click(byId("gbp-widget-save"));
    expect(byId("gbp-widget-state-disabled")).not.toBeNull();
  });

  it("a rotated id replaces the snippet from the 200", async () => {
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: META };
    await render();
    await click(byId("gbp-widget-rotate"));
    await clickText("Yes, rotate");
    expect(byId("gbp-widget-snippet")?.textContent).toContain(`data-crestahq-reviews="${"Z".repeat(32)}"`);
  });

  it("a revoked widget is gone from the 200, with the gate on or off", async () => {
    for (const googleEnabledByAgency of [true, false]) {
      ctx.subAccount = { googleEnabledByAgency, gbpWidgetMeta: META };
      await render();
      await click(byId("gbp-widget-revoke"));
      await clickText("Yes, revoke");
      expect(byId("gbp-widget-snippet")).toBeNull();
      expect(byId("gbp-widget-revoke")).toBeNull();
    }
  });

  it("the next snapshot of the doc wins over the answer", async () => {
    await render();
    await click(byId("gbp-widget-save"));
    expect(byId("gbp-widget-snippet")?.textContent).toContain(ID);
    const later = "Y".repeat(32);
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: { ...META, publicId: later } };
    await render();
    expect(byId("gbp-widget-snippet")?.textContent).toContain(`data-crestahq-reviews="${later}"`);
  });
});
