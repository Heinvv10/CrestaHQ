// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetSection } from "./widget-section";

/**
 * The widget card's Layout / Theme controls and its "Preview (saved
 * settings)", rendered for real (jsdom) from the live sub-account doc. The
 * preview runs the REAL public/embed/gbp-reviews.js — jsdom does not fetch
 * script src, so the test runs the file when the card appends its <script>,
 * then fires `load`. Only `fetch` and the context are stubbed.
 */

const SCRIPT = readFileSync(join(process.cwd(), "public/embed/gbp-reviews.js"), "utf8");
const ctx = vi.hoisted(() => ({ subAccountId: "sa1", isAdmin: true, loading: false, subAccount: {} as Record<string, unknown> }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));

const API = "/api/sub-accounts/sa1/gbp/widget";
const ID = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const FEED = `${window.location.origin}/api/public/gbp/feed/${ID}`;
const META = { publicId: ID, enabled: true, allowedOrigins: ["https://www.velocityfibre.co.za"], maxReviews: 12, updatedAt: new Date() };
const review = (n: number) => ({
  id: `r${n}`, author: { name: `Reviewer ${n}`, photoUrl: null, anonymous: false }, rating: 5, text: `Review text ${n}`,
  createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-01T09:00:00.000Z", reply: null,
});
const feedBody = (layout: string, theme = "light") => ({
  version: 1, status: "ok", listing: { title: "Velo Test Fibre", mapsUri: "https://maps.google.com/?cid=1", writeReviewUri: null },
  rating: { average: 4.5, count: 3 }, source: { name: "Google", attribution: "Reviews from Google" }, display: { layout, theme },
  freshness: { lastSuccessfulSyncAt: "2026-09-10T08:00:00.000Z", stale: false, generatedAt: "2026-09-10T09:00:00.000Z" },
  reviews: [review(1), review(2), review(3)],
});

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
let feedResponse: () => unknown;

beforeEach(() => {
  ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: null };
  feedResponse = () => json(feedBody("carousel"));
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === FEED) return feedResponse();
    if (url === API && init?.method === "PUT") {
      return json({ widget: { ...META, ...JSON.parse(String(init.body)), updatedAt: "2026-09-11T00:00:00.000Z" } });
    }
    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  document.head.innerHTML = "";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (window as { crestahqReviews?: unknown }).crestahqReviews;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render() {
  await act(async () => root.render(createElement(WidgetSection)));
}
const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const embedScripts = () => [...document.head.querySelectorAll<HTMLScriptElement>("script")].filter((s) => s.getAttribute("src") === "/embed/gbp-reviews.js");
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}
/** What a browser does with the appended <script>: run the real file, then fire `load`. */
async function loadEmbed() {
  const [script] = embedScripts();
  if (!script) throw new Error("the card appended no embed script");
  await act(async () => {
    new Function(SCRIPT)();
    script.dispatchEvent(new Event("load"));
  });
  await settle();
}
async function choose(testId: string, value: string) {
  const select = byId(testId) as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Layout and Theme", () => {
  it("offer Carousel / Grid / List / Badge and Light / Dark, defaulting to carousel + light for a new widget", async () => {
    await render();
    const layout = byId("gbp-widget-layout") as HTMLSelectElement;
    const theme = byId("gbp-widget-theme") as HTMLSelectElement;
    expect([...layout.options].map((o) => [o.value, o.text])).toEqual([["carousel", "Carousel"], ["grid", "Grid"], ["list", "List"], ["badge", "Badge"]]);
    expect([...theme.options].map((o) => [o.value, o.text])).toEqual([["light", "Light"], ["dark", "Dark"]]);
    expect(layout.value).toBe("carousel");
    expect(theme.value).toBe("light");
    expect(byId("gbp-widget-preview")).toBeNull();
  });

  it("are saved with the existing Save", async () => {
    await render();
    await choose("gbp-widget-layout", "grid");
    await choose("gbp-widget-theme", "dark");
    await act(async () => byId("gbp-widget-save")!.click());
    const put = fetchMock.mock.calls.find(([u, i]) => u === API && (i as RequestInit).method === "PUT")!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ enabled: true, allowedOrigins: [], maxReviews: 12, layout: "grid", theme: "dark" });
  });

  it("prefill from the saved widget, and read a widget from before layouts as carousel + light", async () => {
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: { ...META, layout: "badge", theme: "dark" } };
    await render();
    expect((byId("gbp-widget-layout") as HTMLSelectElement).value).toBe("badge");
    expect((byId("gbp-widget-theme") as HTMLSelectElement).value).toBe("dark");
    await act(async () => root.unmount());
    root = createRoot(container);
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: META };
    await render();
    expect((byId("gbp-widget-layout") as HTMLSelectElement).value).toBe("carousel");
    expect((byId("gbp-widget-theme") as HTMLSelectElement).value).toBe("light");
  });
});

describe("Preview (saved settings)", () => {
  beforeEach(() => {
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: { ...META, layout: "grid", theme: "dark" } };
  });

  it("runs the real embed against this widget's feed, same-origin and revalidated, in the saved layout", async () => {
    feedResponse = () => json(feedBody("grid", "dark"));
    await render();
    expect(byId("gbp-widget-preview-loading")).not.toBeNull();
    expect(embedScripts()).toHaveLength(1);
    await loadEmbed();
    expect(fetchMock).toHaveBeenCalledWith(FEED, { credentials: "omit", cache: "no-cache" });
    const preview = byId("gbp-widget-preview")!;
    expect(preview.querySelector(".chq-reviews--grid.chq-reviews--dark")).not.toBeNull();
    expect(preview.querySelectorAll(".chq-reviews__card")).toHaveLength(3);
    expect(preview.querySelector(".chq-reviews__source")?.textContent).toBe("Reviews from Google");
    expect(byId("gbp-widget-preview-loading")).toBeNull();
    expect(byId("gbp-widget-preview-fallback")).toBeNull();
  });

  it("re-renders when the saved layout changes, without loading the script twice", async () => {
    feedResponse = () => json(feedBody("grid", "dark"));
    await render();
    await loadEmbed();
    // ONLY the layout changes: the theme, enabled and maxReviews stay as they were.
    feedResponse = () => json(feedBody("badge", "dark"));
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: { ...META, layout: "badge", theme: "dark" } };
    await render();
    await settle();
    expect(embedScripts()).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([u]) => u === FEED)).toHaveLength(2);
    const preview = byId("gbp-widget-preview")!;
    expect(preview.querySelectorAll(".chq-reviews")).toHaveLength(1);
    expect(preview.querySelector(".chq-reviews--badge")).not.toBeNull();
    expect(preview.querySelector(".chq-reviews__card")).toBeNull();
  });

  it("says so when the feed has nothing to show (e.g. switched off)", async () => {
    feedResponse = () => json({ error: "not_found" }, 404);
    await render();
    await loadEmbed();
    // The embed falls back on ANY refusal (404 off, 429, unavailable, network), so the copy must not name one cause.
    expect(byId("gbp-widget-preview-fallback")?.textContent).toBe(
      "The feed isn't available right now — the widget may be switched off, not yet synced, or unreachable. Sites show their static content.",
    );
    expect(byId("gbp-widget-preview")!.querySelector(".chq-reviews")).toBeNull();
  });

  it("says so when the embed script cannot load, and tries again next time", async () => {
    await render();
    await act(async () => embedScripts()[0].dispatchEvent(new Event("error")));
    await settle();
    expect(byId("gbp-widget-preview-error")).not.toBeNull();
    expect(embedScripts()).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[gbp\/widget-preview\]/), expect.anything());
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: { ...META, layout: "list", theme: "light" } };
    await render();
    expect(embedScripts()).toHaveLength(1);
  });

  it("a script that loads WITHOUT the mount hook (e.g. an old cached copy) shows the error, never hangs — and the next preview retries", async () => {
    await render();
    // `load` fires, but the file never defined window.crestahqReviews.
    await act(async () => embedScripts()[0].dispatchEvent(new Event("load")));
    await settle();
    expect(byId("gbp-widget-preview-error")).not.toBeNull();
    expect(byId("gbp-widget-preview-loading")).toBeNull();
    expect(embedScripts()).toHaveLength(0);
    feedResponse = () => json(feedBody("list"));
    ctx.subAccount = { googleEnabledByAgency: true, gbpWidgetMeta: { ...META, layout: "list", theme: "light" } };
    await render();
    expect(embedScripts()).toHaveLength(1);
    await loadEmbed();
    expect(byId("gbp-widget-preview")!.querySelectorAll(".chq-reviews--list .chq-reviews__card")).toHaveLength(3);
    expect(byId("gbp-widget-preview-error")).toBeNull();
  });

  it("does not wait on a script tag that already fired without the hook: it is replaced", async () => {
    feedResponse = () => json(feedBody("grid", "dark"));
    const stale = document.createElement("script");
    stale.setAttribute("src", "/embed/gbp-reviews.js");
    stale.dataset.loaded = "";
    document.head.append(stale);
    await render();
    expect(stale.isConnected).toBe(false);
    expect(embedScripts()).toHaveLength(1);
    await loadEmbed();
    expect(byId("gbp-widget-preview")!.querySelectorAll(".chq-reviews__card")).toHaveLength(3);
  });
});
