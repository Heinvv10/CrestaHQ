/**
 * The one rule deciding whether a WhatsApp message leaves as free-form text or
 * as a pre-approved template. Pure — no I/O, no Firestore, no provider SDK —
 * so every rail obeys the same decision and it can be tested exhaustively.
 *
 * Why this file earns its keep: Meta bills a marketing template at ~$0.040 and
 * a free-form message inside an open 24-hour service window at $0.00. Velocity
 * currently sends its post-button review ask as a template in the same minute
 * the customer's tap opened that window — ~$87/mo across two sub-accounts for
 * messages that should be free. Leaving that choice to whoever built the
 * workflow is what makes it recur; encoding it here makes it structural.
 *
 * Ported from ndzinga-lms/lib/whatsapp/send-mode.ts and extended with the
 * provider-capability arm, because CrestaHQ will run three rails rather than
 * two.
 */

import type { WhatsAppProviderCapabilities } from "./provider";

export type WaSendMode =
  | { mode: "text" }
  | { mode: "template" }
  | { mode: "error"; error: string; providerOutcome: "DEFINITELY_REJECTED" };

/** Stable code the composer keys off to prompt "pick a template". */
export const WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE =
  "WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE";

export const DEFAULT_WA_WINDOW_HOURS = 24;

/**
 * Meta's window is exclusive at its upper bound: at exactly 24h the window is
 * shut. A future `lastInboundAt` (clock skew between the webhook writer and
 * this reader) is treated as open — a just-received inbound is by definition
 * inside the window, and erring closed there would refuse a legitimate reply.
 */
export function isWithinServiceWindow(
  lastInboundAt: Date | null,
  now: Date,
  windowHours: number = DEFAULT_WA_WINDOW_HOURS,
): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < windowHours * 3600_000;
}

/**
 * Order matters. Free-form wins whenever it is legal, because it is free.
 * A template is the fallback for a closed window, never the preference.
 */
export function resolveWaSendMode(opts: {
  lastInboundAt: Date | null;
  hasApprovedTemplate: boolean;
  now: Date;
  windowHours?: number;
  capabilities: WhatsAppProviderCapabilities;
}): WaSendMode {
  // A rail outside Meta's system (the unofficial bridge) has no service window
  // and no template concept, so there is nothing to decide. This branch is
  // deliberately explicit: it exists so that adding such a provider is a
  // capability declaration rather than a guard that quietly stops applying.
  if (!opts.capabilities.enforcesWindow) return { mode: "text" };

  if (
    isWithinServiceWindow(
      opts.lastInboundAt,
      opts.now,
      opts.windowHours ?? DEFAULT_WA_WINDOW_HOURS,
    )
  ) {
    return { mode: "text" };
  }

  if (opts.hasApprovedTemplate && opts.capabilities.supportsTemplates) {
    return { mode: "template" };
  }

  // Outside the window with no legal way to reach the contact. Refuse here,
  // before any HTTP request — a send attempted anyway is both billed and a
  // quality-rating hit.
  return {
    mode: "error",
    error: WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE,
    providerOutcome: "DEFINITELY_REJECTED",
  };
}
