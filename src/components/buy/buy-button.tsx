"use client";

import { useEffect, useState } from "react";

import { readableTextOn, safeAccent } from "@/components/buy/buy-shell";

/**
 * Creates the Stripe session on click, never on load: JS-rendering crawlers
 * and link previews would otherwise mint a pending order per visit. Sends a
 * request id minted once per page load, so a double click (or a click after
 * coming back from Stripe) reuses the session just opened instead of a second.
 */
/** A UUID v4. `randomUUID` exists only in secure contexts on newer browsers;
 *  `getRandomValues` everywhere, so build one from it when it's missing. */
export function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function BuyButton({
  subAccountId,
  slug,
  accent,
  label,
  askEmail = false,
}: {
  subAccountId: string;
  slug: string;
  accent: string;
  label: string;
  /** Paystack's hosted page shows the buyer's email but doesn't ask for it. */
  askEmail?: boolean;
}) {
  const [requestId] = useState(newRequestId);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Back from Stripe restores this page from the back/forward cache with the
  // button still spinning; reset it.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const color = safeAccent(accent);
  const textColor = readableTextOn(color);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/co/${encodeURIComponent(subAccountId)}/buy/${encodeURIComponent(slug)}/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(askEmail ? { requestId, email } : { requestId }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? "Something went wrong. Please try again.");
      }
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div>
      {askEmail && (
        <label className="mb-3 block text-sm font-medium text-zinc-700">
          Your email (for the receipt)
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 h-11 w-full rounded-xl border border-zinc-300 px-3 text-base font-normal"
          />
        </label>
      )}
      <button
        type="button"
        onClick={go}
        disabled={busy || (askEmail && !email.trim())}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-semibold shadow-sm transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-70"
        style={{ background: color, color: textColor, outlineColor: color }}
      >
        {busy && (
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        )}
        {busy ? "Opening secure checkout…" : label}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-center text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
