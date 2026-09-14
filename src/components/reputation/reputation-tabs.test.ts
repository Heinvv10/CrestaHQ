// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/sa/sa1/reputation" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ({ subAccountId: "sa1" }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...rest }, children),
}));

import { ReputationTabs } from "./reputation-tabs";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const current = () =>
  [...container.querySelectorAll("a")].filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.dataset.testid);

it.each([
  ["/sa/sa1/reputation", "rep-tab-overview"],
  ["/sa/sa1/reputation/reviews", "rep-tab-reviews"],
  ["/sa/sa1/reputation/requests", "rep-tab-requests"],
  ["/sa/sa1/reputation/widgets", "rep-tab-widgets"],
  ["/sa/sa1/reputation/insights", "rep-tab-insights"],
])("on %s exactly one tab is current: %s", async (path, id) => {
  nav.pathname = path;
  await act(async () => root.render(createElement(ReputationTabs)));
  expect(current()).toEqual([id]);
  expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
    "/sa/sa1/reputation", "/sa/sa1/reputation/reviews", "/sa/sa1/reputation/requests", "/sa/sa1/reputation/widgets", "/sa/sa1/reputation/insights",
  ]);
});
