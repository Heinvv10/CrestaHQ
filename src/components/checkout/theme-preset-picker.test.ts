// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemePresetPicker } from "./theme-preset-picker";
import { CHECKOUT_THEMES } from "@/lib/checkout/themes";
import type { CheckoutThemeId } from "@/types/checkout-pages";

/** The style picker both page editors share: what a click reports, and what shows as chosen. */

let root: Root;
let container: HTMLDivElement;
const onChange = vi.fn<(next: CheckoutThemeId | null) => void>();

async function render(props: { value: CheckoutThemeId | null; allowNone?: boolean; noneBlurb?: string }) {
  await act(async () => root.render(createElement(ThemePresetPicker, { ...props, onChange })));
}
const cards = () => [...container.querySelectorAll("button")];
const card = (label: string) => cards().find((b) => b.textContent?.startsWith(label))!;
const pressed = () => cards().filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onChange.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ThemePresetPicker", () => {
  it("offers one card per preset, and a click reports that preset's id", async () => {
    await render({ value: "clean" });
    const themes = Object.values(CHECKOUT_THEMES);
    expect(cards()).toHaveLength(themes.length);
    for (const t of themes) {
      onChange.mockClear();
      await act(async () => card(t.label).click());
      expect(onChange.mock.calls).toEqual([[t.id]]);
    }
  });

  it("marks only the chosen preset", async () => {
    await render({ value: "noir-lime" });
    expect(pressed()).toEqual([`Noir Lime${CHECKOUT_THEMES["noir-lime"].blurb}`]);
  });

  it("has no way to clear the preset unless asked for one", async () => {
    await render({ value: null });
    expect(container.textContent).not.toContain("Brand default");
    expect(pressed()).toEqual([]);
  });

  it("with allowNone, leads with a card that reports null and is chosen when there is no preset", async () => {
    await render({ value: null, allowNone: true, noneBlurb: "The old look." });
    expect(cards()).toHaveLength(Object.keys(CHECKOUT_THEMES).length + 1);
    expect(cards()[0].textContent).toBe("Brand defaultThe old look.");
    expect(pressed()).toEqual(["Brand defaultThe old look."]);
    await act(async () => cards()[0].click());
    expect(onChange.mock.calls).toEqual([[null]]);

    await render({ value: "ocean", allowNone: true });
    expect(pressed()).toEqual([`Ocean${CHECKOUT_THEMES.ocean.blurb}`]);
  });

  it("never submits the form it sits in", async () => {
    await render({ value: null, allowNone: true });
    expect(cards().every((b) => b.getAttribute("type") === "button")).toBe(true);
  });
});
