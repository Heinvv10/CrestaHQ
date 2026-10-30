"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, KeyRound, Sparkles, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Setup-progress banner for the Get-started page. Reads the counts-only
 * summary endpoint (owner-gated, works even before the setup form is
 * enabled) and renders one of two states:
 *
 *   • REQUIRED incomplete (amber, not dismissable) — a boot-tier group is
 *     missing keys or failing a shape check; the app can't fully run.
 *   • OPTIONAL remaining (sky, dismissable) — core setup is done, some
 *     feature integrations aren't configured yet.
 *
 * Renders nothing while loading, on any fetch error, when everything is
 * configured, or when the optional state was dismissed — the banner should
 * never be the reason the page feels broken.
 */

const DISMISS_KEY = "gs-setup-banner-dismissed";

interface SetupSummary {
  ok: boolean;
  requiredComplete: boolean;
  missingRequiredKeys: number;
  requiredIssues: string[];
  featuresConfigured: number;
  featuresTotal: number;
  featuresRemaining: string[];
}

export function SetupStatusBanner() {
  const [summary, setSummary] = useState<SetupSummary | null>(null);
  const [dismissed, setDismissed] = useState(true); // assume dismissed until read

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
    let cancelled = false;
    void fetch("/api/agency/setup/summary")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SetupSummary | null) => {
        if (!cancelled && d?.ok) setSummary(d);
      })
      .catch(() => {
        // Fail soft — no banner beats a broken-looking one.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!summary) return null;

  // ── Required incomplete — amber, always shown ────────────────────────────
  if (!summary.requiredComplete) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 sm:flex-row sm:items-center">
        <div className="flex flex-1 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <TriangleAlert className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              Required setup incomplete
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {summary.requiredIssues.join(", ")}{" "}
              {summary.requiredIssues.length === 1 ? "needs" : "need"} attention
              {summary.missingRequiredKeys > 0 &&
                ` (${summary.missingRequiredKeys} required ${
                  summary.missingRequiredKeys === 1 ? "key" : "keys"
                } missing)`}
              . Core features can&apos;t run until these are set — Guided setup
              walks you through each key and writes it for you.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 justify-end sm:justify-start">
          <Button size="sm" render={<Link href="/agency/setup" />}>
            <KeyRound className="mr-1 h-3.5 w-3.5" />
            Open Guided setup
            <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        </div>
      </div>
    );
  }

  // ── All configured — nothing to say ──────────────────────────────────────
  if (summary.featuresRemaining.length === 0 || dismissed) return null;

  // ── Core done, optional integrations remaining — sky, dismissable ────────
  const remaining = summary.featuresRemaining;
  const shown = remaining.slice(0, 3).join(", ");
  const more = remaining.length - 3;
  return (
    <div className="relative flex flex-col gap-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4 pr-10 sm:flex-row sm:items-center">
      <div className="flex flex-1 items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-sky-700 dark:text-sky-400">
            Core setup complete — {summary.featuresConfigured} of{" "}
            {summary.featuresTotal} optional integrations configured
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Still available: {shown}
            {more > 0 && ` +${more} more`}. Each unlocks a feature — add them
            anytime in Guided setup.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 justify-end sm:justify-start">
        <Button
          size="sm"
          variant="outline"
          render={<Link href="/agency/setup" />}
        >
          <KeyRound className="mr-1 h-3.5 w-3.5" />
          Open Guided setup
          <ArrowRight className="ml-1 h-3 w-3" />
        </Button>
      </div>
      <button
        type="button"
        aria-label="Dismiss setup banner"
        className="absolute right-2.5 top-2.5 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={() => {
          setDismissed(true);
          try {
            localStorage.setItem(DISMISS_KEY, "1");
          } catch {
            // localStorage unavailable — dismiss for this render only.
          }
        }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
