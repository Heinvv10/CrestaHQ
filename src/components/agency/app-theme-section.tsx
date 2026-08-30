"use client";

import { useState } from "react";
import { Check, Paintbrush } from "lucide-react";
import { toast } from "sonner";
import { useAgency } from "@/hooks/use-agency";
import { LANDING_VARIANT } from "@/config/landing";
import { cn } from "@/lib/utils";
import type { AppTheme } from "@/types";

/**
 * Agency settings — dashboard accent theme picker. Three options; the
 * choice writes to agency.appTheme and applies live everywhere (including
 * the installed PWA — same app) via <AppAccent/>. "Default" annotation
 * follows the deployment mode: buyers default to green, the LeadStack
 * demo to neutral.
 */

const MODE_DEFAULT: AppTheme =
  LANDING_VARIANT === "custom" ? "green" : "neutral";

const OPTIONS: {
  value: AppTheme;
  label: string;
  hint: string;
  swatch: string;
}[] = [
  {
    value: "green",
    label: "Green",
    hint: "The emerald “my CRM” palette — matches the landing page and default app icon.",
    swatch: "bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-300",
  },
  {
    value: "leadstack",
    label: "Indigo",
    hint: "The LeadStack design language — indigo/violet accents.",
    swatch: "bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500",
  },
  {
    value: "neutral",
    label: "Neutral",
    hint: "Monochrome — buttons and highlights follow light/dark foreground.",
    swatch: "bg-gradient-to-r from-zinc-800 to-zinc-500 dark:from-zinc-200 dark:to-zinc-400",
  },
];

export function AppThemeSection() {
  const agency = useAgency();
  const [saving, setSaving] = useState<AppTheme | null>(null);
  const active = agency.appTheme ?? MODE_DEFAULT;

  async function pick(theme: AppTheme) {
    if (theme === active || saving) return;
    setSaving(theme);
    try {
      const res = await fetch("/api/agency", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appTheme: theme }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) throw new Error(payload.error ?? "Could not save.");
      toast.success("App theme updated.");
      // useAgency's onSnapshot picks up the change; AppAccent re-applies.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border bg-card p-5">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <Paintbrush className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">App theme</h2>
          <p className="text-xs text-muted-foreground">
            Accent color for buttons, highlights, and the installed mobile
            app. Applies for every user in this deployment.
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {OPTIONS.map((opt) => {
          const selected = active === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={saving !== null}
              onClick={() => void pick(opt.value)}
              className={cn(
                "rounded-xl border p-3 text-left transition-all active:scale-[0.99]",
                selected
                  ? "border-primary ring-2 ring-primary/30"
                  : "hover:border-primary/40",
              )}
            >
              <div className={cn("h-2.5 w-full rounded-full", opt.swatch)} />
              <div className="mt-2 flex items-center justify-between gap-1">
                <span className="text-sm font-medium">
                  {opt.label}
                  {opt.value === MODE_DEFAULT && (
                    <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                      default
                    </span>
                  )}
                </span>
                {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </div>
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                {opt.hint}
              </p>
            </button>
          );
        })}
      </div>
    </section>
  );
}
