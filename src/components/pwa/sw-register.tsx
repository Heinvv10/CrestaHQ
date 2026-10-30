"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Registers the push-only service worker (public/sw.js). Skips /embed/*
 * so the web-chat widget iframe never registers a worker on behalf of the
 * host page's visitors — same skip AnalyticsScripts uses for Crisp/GTM.
 *
 * Registration is idempotent (the browser no-ops when the same script URL
 * is already registered) and failure is silent — the app works identically
 * without a worker; only install + push depend on it.
 */
export function SwRegister() {
  const pathname = usePathname();
  const isEmbed = pathname?.startsWith("/embed");

  useEffect(() => {
    if (isEmbed) return;
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => console.warn("[pwa] service worker registration failed", err));
  }, [isEmbed]);

  return null;
}
