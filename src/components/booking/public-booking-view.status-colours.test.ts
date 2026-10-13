// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicBookingView } from "./public-booking-view";
import { CHECKOUT_THEMES } from "@/lib/checkout/themes";
import { contrast, hexToRgb, over, tailwindColor } from "@/test/contrast";
import { seedPage } from "@/test/booking-harness";
import type { CheckoutThemeId } from "@/types/checkout-pages";

/**
 * Status text on the public booking page (deposit chip, load error, payment
 * notice, form error, confirmation), walked through every state in a DOM.
 *
 * A preset fixes the card's lightness whatever the visitor's own theme is,
 * so under a preset each status colour must come from the preset — readable
 * on its card (WCAG AA, 4.5:1) — and carry no `dark:` variant, which would
 * still fire for a dark-mode visitor on a light card. With no preset the
 * classes are exactly what they were before presets.
 */

let root: Root;
let container: HTMLDivElement;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const SLOT = { startAt: "2026-09-14T09:00:00.000Z", endAt: "2026-09-14T09:30:00.000Z" };
const PAYMENT = { amount: 50, currency: "USD", description: "Deposit", holdHours: 24 };
const PRESETS = Object.keys(CHECKOUT_THEMES) as CheckoutThemeId[];

async function render(over: Record<string, unknown>) {
  const page = { ...seedPage("p", over as never), createdAt: null, updatedAt: null };
  await act(async () =>
    root.render(createElement(PublicBookingView, { subAccountId: "sa1", page, branding: { name: "Fixture", logoUrl: null, accentColor: null } })),
  );
}
const type = async (selector: string, value: string) => {
  const el = container.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = () =>
  act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

/** The status text classes on show right now, e.g. `text-rose-700 dark:text-rose-400`. */
const statusClasses = () =>
  [...container.querySelectorAll("main *")]
    .map((el) => (el.getAttribute("class") ?? "").split(/\s+/).filter((c) => /(^|:)text-(emerald|amber|rose)-\d+$/.test(c)).join(" "))
    .filter(Boolean);

/**
 * Walks one page through every status state, calling `check` at each: the
 * load error; then the deposit chip and payment notice; the form error; the
 * pay-to-confirm panel; and (without a deposit) the booked panel.
 */
async function walk(preset: CheckoutThemeId | null, check: (state: string, classes: string[]) => void) {
  const themePreset = preset ?? undefined;
  const seen: string[] = [];
  const at = (state: string, expected: number) => {
    const classes = statusClasses();
    expect(classes, `${preset} ${state}`).toHaveLength(expected);
    seen.push(...classes);
    check(state, classes);
  };

  fetchMock.mockImplementation(async () => Response.json({ error: "Down for a moment." }, { status: 503 }));
  await render({ themePreset, payment: PAYMENT });
  expect(container.textContent).toContain("Down for a moment.");
  at("load error", 2); // deposit chip + the error box

  for (const [payment, status] of [[PAYMENT, "awaiting_payment"], [null, "scheduled"]] as const) {
    await act(async () => root.unmount());
    root = createRoot(container);
    fetchMock.mockImplementation(async (url) =>
      url.endsWith("/book") ? Response.json({ ok: true, status, paymentUrl: "https://pay.example/x" }) : Response.json({ slots: [SLOT] }),
    );
    await render({ themePreset, payment });
    await act(async () => [...container.querySelectorAll("button")].find((b) => /^\d{1,2}:\d{2}/.test(b.textContent ?? ""))!.click());
    at(payment ? "deposit chip + payment notice" : "slot picked, no deposit", payment ? 2 : 0);

    await submit();
    expect(container.textContent).toContain("Name, email, and phone are required.");
    at("form error", payment ? 3 : 1);

    await type("#b-name", "Ann");
    await type("#b-email", "ann@example.com");
    await type("#b-phone", "+27600000000");
    await submit();
    expect(container.textContent).toContain(payment ? "pay to confirm" : "You're booked.");
    at(payment ? "pay-to-confirm panel" : "booked panel", payment ? 2 : 1);
  }
  return seen;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("status colours on the public booking page", () => {
  it("with no preset, every state keeps the light colour with its dark: variant", async () => {
    const seen = await walk(null, () => undefined);
    expect([...new Set(seen)].sort()).toEqual([
      "text-amber-700 dark:text-amber-400",
      "text-emerald-700 dark:text-emerald-400",
      "text-rose-700 dark:text-rose-400",
    ]);
    expect(container.querySelector("main")!.className).not.toMatch(/(^|\s)(dark|light)(\s|$)/);
  });

  it.each(PRESETS)("%s: no dark: class is left anywhere inside the themed page, in any state", async (preset) => {
    await walk(preset, (state) => {
      expect(container.querySelector("main")!.outerHTML, `${preset} ${state}`).not.toContain("dark:");
    });
  });

  it.each(PRESETS)("%s: every status colour is readable on the preset's card (4.5:1), in every state", async (preset) => {
    const theme = CHECKOUT_THEMES[preset];
    const card = hexToRgb(theme.cardBg);
    const seen = await walk(preset, (state, classes) => {
      for (const cls of classes) {
        const [, hue, shade] = /^text-(emerald|amber|rose)-(\d+)$/.exec(cls)!;
        const text = tailwindColor(`${hue}-${shade}`);
        expect(contrast(text, card), `${preset} ${state} ${cls} on the card`).toBeGreaterThanOrEqual(4.5);
        // Its own box is the hue's 500 at up to 10% over the card.
        expect(contrast(text, over(tailwindColor(`${hue}-500`), 0.1, card)), `${preset} ${state} ${cls} on its tint`).toBeGreaterThanOrEqual(4.5);
      }
    });
    // All three hues were on show at some point.
    expect([...new Set(seen.map((c) => c.split("-")[1]))].sort()).toEqual(["amber", "emerald", "rose"]);
  });

  it.each(PRESETS)("%s: the page is marked with the preset's own scheme", async (preset) => {
    fetchMock.mockImplementation(async () => Response.json({ slots: [] }));
    await render({ themePreset: preset });
    const main = container.querySelector("main")!;
    expect(main.classList.contains("dark")).toBe(CHECKOUT_THEMES[preset].isDark);
    expect(main.classList.contains("light")).toBe(!CHECKOUT_THEMES[preset].isDark);
  });
});
