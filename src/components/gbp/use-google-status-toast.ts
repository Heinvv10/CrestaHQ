"use client";

import { useEffect } from "react";
import { toast } from "sonner";

/**
 * The `?google=…` statuses the connect/callback routes redirect back with.
 * Shared by the Settings card and the Google Business page so the two can
 * never disagree about what a status means.
 */
export const GOOGLE_STATUS_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Google Business Profile connected." },
  cancelled: { ok: false, text: "Connection cancelled." },
  bad_state: {
    ok: false,
    text: "Connection failed a security check. Try again.",
  },
  not_configured: {
    ok: false,
    text: "Google isn't configured on this deployment yet (missing OAuth client credentials).",
  },
  gate_off: { ok: false, text: "This feature is locked by your agency." },
  no_refresh_token: {
    ok: false,
    text: "Google didn't return a long-lived token. Remove this app at myaccount.google.com → Security → Third-party access, then connect again.",
  },
  insufficient_scope: {
    ok: false,
    text: "Google didn't grant Business Profile access. Connect again and leave the Business Profile permission ticked.",
  },
  error: { ok: false, text: "Couldn't connect to Google. Please try again." },
};

/**
 * Toast the `?google=…` status once, then strip it from the URL so a refresh
 * doesn't re-toast.
 */
export function useGoogleStatusToast(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("google");
    if (!status) return;
    const msg = GOOGLE_STATUS_MESSAGES[status];
    if (msg) {
      if (msg.ok) toast.success(msg.text);
      else toast.error(msg.text);
    }
    params.delete("google");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
  }, []);
}
