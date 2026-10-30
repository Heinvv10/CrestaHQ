"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpFromDot, Download, X } from "lucide-react";

/**
 * Mobile install prompt for the dashboard (PWA v1). Shown once, dismissible
 * (localStorage), and only when it can actually help:
 *   - only inside the authed dashboard (this component is mounted in the
 *     (dashboard) layout), so public/marketing pages never see it in
 *     EITHER deployment mode. In "leadstack" demo mode the manifest is
 *     itself auth-surface-only (see pwa-links.tsx) — install here is the
 *     operator's own test surface, wearing LeadStack's identity.
 *   - never when already running installed (display-mode: standalone)
 *   - Android/Chromium: appears when the browser fires `beforeinstallprompt`;
 *     the button hands off to the captured native prompt
 *   - iOS Safari: no install event exists, so show Share → Add to Home
 *     Screen instructions — on iPhone this is also the gate to push
 *     notifications, which is why the copy leads with lead alerts
 *
 * The md:hidden wrapper keeps it phone-only; desktop users install from
 * the browser's own omnibox affordance if they care.
 */

const DISMISS_KEY = "leadstack-install-banner-dismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function InstallBanner() {
  const [mode, setMode] = useState<"hidden" | "android" | "ios">("hidden");
  const [installEvent, setInstallEvent] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(DISMISS_KEY)) return;
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) return;

    const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (isIos) {
      setMode("ios");
      return;
    }

    // Chromium fires this only when the app is installable and not yet
    // installed — the event IS the "show the banner" signal.
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
      setMode("android");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (mode === "hidden") return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setMode("hidden");
  };

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    if (choice.outcome === "accepted") setMode("hidden");
  };

  return (
    <div className="border-b bg-card px-4 py-2.5 md:hidden">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
          {mode === "android" ? (
            <Download className="h-3.5 w-3.5" />
          ) : (
            <ArrowUpFromDot className="h-3.5 w-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1 text-xs">
          {mode === "android" ? (
            <>
              <p className="font-medium">Install the app</p>
              <p className="mt-0.5 text-muted-foreground">
                Get lead alerts on your phone the moment they come in.{" "}
                <button
                  onClick={() => void install()}
                  className="font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
                >
                  Install now
                </button>
              </p>
            </>
          ) : (
            <>
              <p className="font-medium">Add to your home screen</p>
              <p className="mt-0.5 text-muted-foreground">
                Lead alerts on iPhone need the installed app: tap Safari&apos;s{" "}
                <span className="font-medium">Share</span> button, then{" "}
                <span className="font-medium">Add to Home Screen</span>. Then
                turn on alerts in{" "}
                <Link
                  href="/me/settings"
                  className="font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
                >
                  your settings
                </Link>
                .
              </p>
            </>
          )}
        </div>
        <button
          onClick={dismiss}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
