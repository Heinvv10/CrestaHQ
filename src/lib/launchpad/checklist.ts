/**
 * SP13 (d) — per-sub-account Launchpad checklist.
 *
 * Pure predicates only: every item's `done` is derived from the exact
 * doc/collection the feature itself already writes — never a new stored
 * flag. This keeps the checklist honest (it can never say "done" for a
 * connection that was quietly torn down elsewhere) at the cost of needing
 * one small read per item; the caller (the launchpad API route + page)
 * owns fetching `LaunchpadSubAccount` and `LaunchpadCounts`.
 *
 * Predicates are deliberately reused, not reinvented, from the settings
 * cards / helpers that already own each connection's "connected" meaning:
 *   - email: `sub-account-smtp-section.tsx` (SMTP) / resend domain verify
 *   - whatsapp: `lib/comms/whatsapp/sender-configured.ts`, called by the
 *     launchpad API ROUTE (it needs `twilioConfig` too, which this module
 *     deliberately does not carry — see `LaunchpadCounts.whatsappConnected`)
 *   - gbp: `components/settings/sub-account-google-section.tsx`
 *
 * `available` mirrors the same cards' own self-gating: an item that a
 * NOT-YET-DONE viewer literally cannot complete (locked agency gate, or not
 * a sub-account admin) is `available: false` with a `reason`, so the page
 * can swap the dead "Set up" button for a one-line explanation instead of
 * sending the viewer to a card that will render nothing for them. Once an
 * item IS done it stays `available: true` regardless of the gate — a
 * connection made before a gate was later turned off is still a real,
 * completed setup, not something to un-count.
 */

export type LaunchpadItemId =
  | "email"
  | "whatsapp"
  | "gbp"
  | "calendar"
  | "contacts"
  | "forms"
  | "workflows";

/** The slice of `SubAccountDoc` the checklist reads. */
export interface LaunchpadSubAccount {
  emailProvider?: "resend" | "smtp";
  smtpConfig?: { verifiedAt?: string | null } | null;
  resendConfig?: { status?: "pending" | "verified" | "failed" } | null;
  emailDomainEnabledByAgency?: boolean;
  googleConnectionMeta?: { connected?: boolean } | null;
  googleEnabledByAgency?: boolean;
}

/** Who is looking at the checklist — drives `available`, not `done`. */
export interface LaunchpadViewer {
  isAdmin: boolean;
}

/**
 * Counts (and rail-aware booleans) that need a read the client can't (or
 * shouldn't) do itself. `whatsappConnected` is computed by the route via
 * `whatsappSenderConfigured()` rather than by this module reading meta
 * fields directly, so a Twilio-only workspace (no Cloud/bridge meta at all)
 * is never misread as unconfigured.
 */
export interface LaunchpadCounts {
  contacts: number;
  forms: number;
  activeWorkflows: number;
  bookingPages: number;
  googleCalendarConnected: boolean;
  whatsappConnected: boolean;
}

export interface LaunchpadItem {
  id: LaunchpadItemId;
  title: string;
  description: string;
  done: boolean;
  /** False when a NOT-YET-DONE viewer has no way to complete this item here. */
  available: boolean;
  /** Set only when `available` is false — why, in one line. */
  reason: string | null;
  href: string;
}

const NOT_ADMIN_REASON = "Only a workspace admin can set this up.";

function emailConnected(sub: LaunchpadSubAccount): boolean {
  // Mirrors sub-account-smtp-section.tsx's own "Active provider" line: SMTP
  // is only active once it holds verified credentials; otherwise Resend is
  // the active provider, and it's only a real sending identity once its
  // dedicated domain verifies (sub-account-email-domain-section.tsx).
  if (sub.emailProvider === "smtp") return !!sub.smtpConfig?.verifiedAt;
  return sub.resendConfig?.status === "verified";
}

/**
 * sub-account-smtp-section.tsx gates SMTP on sub-account admin ONLY — no
 * agency flag — so SMTP is always the fallback setup path for an admin, even
 * with the dedicated-domain gate (emailDomainEnabledByAgency) off. Written
 * as the full OR (domain option, SMTP option) rather than collapsed to
 * `viewer.isAdmin` so this keeps reading correctly if SMTP ever grows its
 * own gate. Only a non-admin viewer has no way to complete this item.
 */
function emailAvailability(
  sub: LaunchpadSubAccount,
  viewer: LaunchpadViewer,
): { available: boolean; reason: string | null } {
  const domainOption = viewer.isAdmin && sub.emailDomainEnabledByAgency === true;
  const smtpOption = viewer.isAdmin;
  if (domainOption || smtpOption) return { available: true, reason: null };
  return { available: false, reason: NOT_ADMIN_REASON };
}

function gbpConnected(sub: LaunchpadSubAccount): boolean {
  return sub.googleConnectionMeta?.connected === true;
}

function gbpAvailability(
  sub: LaunchpadSubAccount,
  viewer: LaunchpadViewer,
): { available: boolean; reason: string | null } {
  if (!viewer.isAdmin) return { available: false, reason: NOT_ADMIN_REASON };
  if (sub.googleEnabledByAgency !== true) {
    return { available: false, reason: "Turned off by your agency." };
  }
  return { available: true, reason: null };
}

export function buildLaunchpadChecklist(
  sub: LaunchpadSubAccount,
  counts: LaunchpadCounts,
  viewer: LaunchpadViewer,
): LaunchpadItem[] {
  const emailDone = emailConnected(sub);
  const email = emailDone ? { available: true, reason: null } : emailAvailability(sub, viewer);
  const gbpDone = gbpConnected(sub);
  const gbp = gbpDone ? { available: true, reason: null } : gbpAvailability(sub, viewer);

  return [
    {
      id: "email",
      title: "Connect email sending",
      description:
        "Connect your own SMTP provider, or verify a dedicated sending domain.",
      done: emailDone,
      available: email.available,
      reason: email.reason,
      href: "/dashboard/settings?tab=messaging",
    },
    {
      id: "whatsapp",
      title: "Connect WhatsApp",
      description: "Connect a WhatsApp number to message and text leads.",
      done: counts.whatsappConnected,
      available: true,
      reason: null,
      href: "/dashboard/settings/whatsapp",
    },
    {
      id: "gbp",
      title: "Connect Google Business Profile",
      description: "Link the Google account that manages your listing.",
      done: gbpDone,
      available: gbp.available,
      reason: gbp.reason,
      href: "/dashboard/settings?tab=messaging",
    },
    {
      id: "calendar",
      title: "Set up calendar/booking",
      description: "Publish a booking page or connect Google Calendar.",
      done: counts.bookingPages > 0 || counts.googleCalendarConnected,
      available: true,
      reason: null,
      href: "/booking",
    },
    {
      id: "contacts",
      title: "Import contacts",
      description: "Bring in your existing contacts to get started.",
      done: counts.contacts > 0,
      available: true,
      reason: null,
      href: "/contacts",
    },
    {
      id: "forms",
      title: "Create a form",
      description: "Build a form to capture new leads from your website.",
      done: counts.forms > 0,
      available: true,
      reason: null,
      href: "/forms",
    },
    {
      id: "workflows",
      title: "Activate a workflow",
      description: "Turn on a workflow to automate your follow-up.",
      done: counts.activeWorkflows > 0,
      available: true,
      reason: null,
      href: "/workflows",
    },
  ];
}
