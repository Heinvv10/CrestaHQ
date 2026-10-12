import { pageCalendarType } from "@/lib/booking/calendar-types";
import { publicBookingStyle } from "@/lib/booking/public-style";
import type { BookingPage, BookingService, IntakeField } from "@/types/booking";
import type { CheckoutThemeId } from "@/types/checkout-pages";

/**
 * What the public booking pages (/b, the embed, /e) may send to the browser.
 *
 * Those pages hand data to a client component, and Next writes every prop it
 * is given into the HTML response for hydration, rendered or not. So the
 * loaders never pass a stored doc: they pass what these builders return,
 * which is an allow-list — each field the views read, picked by name, nested
 * objects included. A field added to the stored doc later (a meeting link,
 * an internal id, migration data) stays on the server unless it is added
 * here AND to the type, which is also the type of the views' props.
 *
 * Deliberately absent: `meetingUrl` (reaches the booker only after booking,
 * in the confirmation email, the calendar invite and reminders),
 * `confirmationMessage` and `redirectUrl` (returned by the book route once a
 * booking exists), hosts (the availability route lists them for pages that
 * let the visitor choose), and every tenancy, territory, audit and
 * migration field.
 */
export interface PublicBookingPageData {
  slug: string;
  name: string;
  description: string;
  durationMinutes: number;
  timezone: string;
  visibleDays: number;
  /** Service pages make the visitor pick one of `services` first. */
  isServicePage: boolean;
  services: BookingService[];
  intakeFields: IntakeField[];
  /** The deposit, as shown to the visitor. Null: free to book. */
  payment: {
    amount: number;
    currency: string;
    description: string | null;
    holdHours: number;
  } | null;
  themePreset: CheckoutThemeId | null;
}

export interface PublicBookingBranding {
  name: string;
  logoUrl: string | null;
  accentColor: string | null;
}

export function publicBookingPage(doc: BookingPage): PublicBookingPageData {
  const isServicePage = pageCalendarType(doc) === "service";
  return {
    slug: doc.slug,
    name: doc.name,
    description: doc.description,
    durationMinutes: doc.durationMinutes,
    timezone: doc.timezone,
    visibleDays: doc.visibleDays,
    isServicePage,
    services: isServicePage
      ? (doc.services ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          durationMinutes: s.durationMinutes,
          description: s.description ?? null,
        }))
      : [],
    intakeFields: (doc.intakeFields ?? []).map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      required: f.required,
      options: f.options ?? null,
    })),
    payment: doc.payment
      ? {
          amount: doc.payment.amount,
          currency: doc.payment.currency,
          description: doc.payment.description ?? null,
          holdHours: doc.payment.holdHours,
        }
      : null,
    themePreset: publicBookingStyle(doc).themePreset,
  };
}

/**
 * A stored logo URL, if it is one the app could have written: http(s), as the
 * branding and booking-page routes require, and no longer than they allow.
 */
function publicLogoUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 2_000) return null;
  try {
    const { protocol } = new URL(v);
    return protocol === "https:" || protocol === "http:" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Name, logo and accent for a public booking page. The page's own logo wins
 * over the sub-account's; `page` is null on /e when the booking page has
 * since been deleted.
 */
export function publicBookingBranding(
  sub: { name?: unknown; logoUrl?: unknown },
  page: { logoUrl?: unknown; accentColor?: unknown } | null,
  fallbackName: string,
): PublicBookingBranding {
  return {
    name: typeof sub.name === "string" ? sub.name : fallbackName,
    logoUrl: publicLogoUrl(page?.logoUrl) ?? publicLogoUrl(sub.logoUrl),
    accentColor: publicBookingStyle(page).accentColor,
  };
}
