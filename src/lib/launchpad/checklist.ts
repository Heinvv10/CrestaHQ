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
 * cards that already own each connection's "connected" meaning:
 *   - email: `sub-account-smtp-section.tsx` (SMTP) / resend domain verify
 *   - whatsapp: `lib/comms/whatsapp/sender-configured.ts`
 *   - gbp: `components/settings/sub-account-google-section.tsx`
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
  whatsappCloudMeta?: { phoneNumberId?: string | null } | null;
  whatsappBridgeMeta?: { displayPhoneNumber?: string | null } | null;
  googleConnectionMeta?: { connected?: boolean } | null;
}

/** Counts that need a read the client can't (or shouldn't) do itself. */
export interface LaunchpadCounts {
  contacts: number;
  forms: number;
  activeWorkflows: number;
  bookingPages: number;
  googleCalendarConnected: boolean;
}

export interface LaunchpadItem {
  id: LaunchpadItemId;
  title: string;
  description: string;
  done: boolean;
  href: string;
}

function emailConnected(sub: LaunchpadSubAccount): boolean {
  // Mirrors sub-account-smtp-section.tsx's own "Active provider" line: SMTP
  // is only active once it holds verified credentials; otherwise Resend is
  // the active provider, and it's only a real sending identity once its
  // dedicated domain verifies (sub-account-email-domain-section.tsx).
  if (sub.emailProvider === "smtp") return !!sub.smtpConfig?.verifiedAt;
  return sub.resendConfig?.status === "verified";
}

function whatsappConnected(sub: LaunchpadSubAccount): boolean {
  // Rail-agnostic on purpose, same reasoning as whatsappSenderConfigured():
  // asking a bridge workspace for a Cloud number (or vice versa) is the
  // wrong check, not a stricter one.
  return (
    !!sub.whatsappCloudMeta?.phoneNumberId ||
    !!sub.whatsappBridgeMeta?.displayPhoneNumber
  );
}

function gbpConnected(sub: LaunchpadSubAccount): boolean {
  return sub.googleConnectionMeta?.connected === true;
}

export function buildLaunchpadChecklist(
  sub: LaunchpadSubAccount,
  counts: LaunchpadCounts,
): LaunchpadItem[] {
  return [
    {
      id: "email",
      title: "Connect email sending",
      description:
        "Connect your own SMTP provider, or verify a dedicated sending domain.",
      done: emailConnected(sub),
      href: "/dashboard/settings",
    },
    {
      id: "whatsapp",
      title: "Connect WhatsApp",
      description: "Connect a WhatsApp number to message and text leads.",
      done: whatsappConnected(sub),
      href: "/dashboard/settings/whatsapp",
    },
    {
      id: "gbp",
      title: "Connect Google Business Profile",
      description: "Link the Google account that manages your listing.",
      done: gbpConnected(sub),
      href: "/dashboard/settings",
    },
    {
      id: "calendar",
      title: "Set up calendar/booking",
      description: "Publish a booking page or connect Google Calendar.",
      done: counts.bookingPages > 0 || counts.googleCalendarConnected,
      href: "/booking",
    },
    {
      id: "contacts",
      title: "Import contacts",
      description: "Bring in your existing contacts to get started.",
      done: counts.contacts > 0,
      href: "/contacts",
    },
    {
      id: "forms",
      title: "Create a form",
      description: "Build a form to capture new leads from your website.",
      done: counts.forms > 0,
      href: "/forms",
    },
    {
      id: "workflows",
      title: "Activate a workflow",
      description: "Turn on a workflow to automate your follow-up.",
      done: counts.activeWorkflows > 0,
      href: "/workflows",
    },
  ];
}
