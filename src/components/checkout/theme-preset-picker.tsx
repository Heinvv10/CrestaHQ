"use client";

import { CHECKOUT_THEMES } from "@/lib/checkout/themes";
import type { CheckoutThemeId } from "@/types/checkout-pages";

/**
 * The 5-preset style picker shared by the Checkout and Booking page editors.
 * Renders one swatch card per preset (mini page/card/button preview).
 *
 * `allowNone` prepends a "Brand default" card that clears the preset —
 * booking pages use it because their legacy look (app theme + optional
 * accent color) predates presets and must stay reachable; checkout pages
 * always have a preset so they omit it.
 */
export function ThemePresetPicker({
  value,
  onChange,
  allowNone = false,
  noneBlurb = "Use the app's standard look.",
}: {
  value: CheckoutThemeId | null;
  onChange: (next: CheckoutThemeId | null) => void;
  allowNone?: boolean;
  noneBlurb?: string;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {allowNone && (
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-pressed={value === null}
          className={`rounded-lg border p-3 text-left transition-colors ${
            value === null
              ? "border-primary ring-1 ring-primary"
              : "hover:border-muted-foreground/40"
          }`}
        >
          <span className="block h-12 w-full overflow-hidden rounded-md border bg-muted/40">
            <span className="mx-auto mt-2 block h-10 w-4/5 rounded-md border bg-card px-2 pt-1.5">
              <span className="block h-1.5 w-2/3 rounded-sm bg-foreground/80" />
              <span className="mt-1.5 block h-2.5 w-full rounded-sm bg-foreground/20" />
            </span>
          </span>
          <span className="mt-2 block text-xs font-medium">Brand default</span>
          <span className="block text-[11px] leading-snug text-muted-foreground">
            {noneBlurb}
          </span>
        </button>
      )}
      {Object.values(CHECKOUT_THEMES).map((t) => {
        const selected = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            aria-pressed={selected}
            className={`rounded-lg border p-3 text-left transition-colors ${
              selected
                ? "border-primary ring-1 ring-primary"
                : "hover:border-muted-foreground/40"
            }`}
          >
            {/* Mini swatch: page bg strip with a card + accent button. */}
            <span
              className="block h-12 w-full overflow-hidden rounded-md border"
              style={{ background: t.pageBg }}
            >
              <span
                className="mx-auto mt-2 block h-10 w-4/5 px-2 pt-1.5"
                style={{
                  background: t.cardBg,
                  borderRadius: Math.min(t.cardRadius, 8),
                  border: t.cardBorder === "none" ? undefined : t.cardBorder,
                }}
              >
                <span
                  className="block h-1.5 w-2/3 rounded-sm"
                  style={{ background: t.text, opacity: 0.85 }}
                />
                <span
                  className="mt-1.5 block h-2.5 w-full rounded-sm"
                  style={{ background: t.buttonBg }}
                />
              </span>
            </span>
            <span className="mt-2 block text-xs font-medium">{t.label}</span>
            <span className="block text-[11px] leading-snug text-muted-foreground">
              {t.blurb}
            </span>
          </button>
        );
      })}
    </div>
  );
}
