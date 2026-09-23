// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * /signup carries the raw invite token in its query string, and these tags
 * report the full page URL — so none may render there.
 */

const path = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => path.current }));
vi.mock("next/script", () => ({
  default: (p: { id: string }) => createElement("script", { "data-tag": p.id }),
}));

const { AnalyticsScripts } = await import("./analytics-scripts");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-X");
  vi.stubEnv("NEXT_PUBLIC_META_PIXEL_ID", "123");
  vi.stubEnv("NEXT_PUBLIC_CRISP_WEBSITE_ID", "crisp");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const tags = () => [...container.querySelectorAll("script")].map((s) => s.dataset.tag);

it("renders no third-party tags on /signup", async () => {
  path.current = "/signup";
  await act(async () => root.render(createElement(AnalyticsScripts)));
  expect(tags()).toEqual([]);
});

it("still renders them elsewhere", async () => {
  path.current = "/login";
  await act(async () => root.render(createElement(AnalyticsScripts)));
  expect(tags()).toEqual(["gtm-script", "meta-pixel", "crisp-widget"]);
});
