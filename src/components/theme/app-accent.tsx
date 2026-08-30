"use client";

import { useEffect } from "react";
import { useAgency } from "@/hooks/use-agency";
import { LANDING_VARIANT } from "@/config/landing";
import type { AppTheme } from "@/types";

/**
 * Applies the agency's accent theme (Agency → Settings → App theme) by
 * toggling a class on <html> — element-level so portalled UI (dialogs,
 * sheets, toasts render at <body>) inherits the CSS-variable overrides
 * too. Renders nothing.
 *
 * Unset theme = deployment-mode default: buyers ("custom") get the green
 * "my CRM" palette; the LeadStack demo stays neutral so its branding never
 * changes unprompted. "neutral" simply removes both classes (stock zinc).
 *
 * Mounted in the (dashboard) layout — the class is cleaned up on unmount
 * so client-navigating out to public pages doesn't carry the accent.
 */

const THEME_CLASSES: Record<Exclude<AppTheme, "neutral">, string> = {
  green: "theme-green",
  leadstack: "theme-leadstack",
};

export function AppAccent() {
  const { appTheme } = useAgency();

  useEffect(() => {
    const resolved: AppTheme =
      appTheme ?? (LANDING_VARIANT === "custom" ? "green" : "neutral");
    const el = document.documentElement;
    el.classList.remove("theme-green", "theme-leadstack");
    if (resolved !== "neutral") el.classList.add(THEME_CLASSES[resolved]);
    return () => {
      el.classList.remove("theme-green", "theme-leadstack");
    };
  }, [appTheme]);

  return null;
}
