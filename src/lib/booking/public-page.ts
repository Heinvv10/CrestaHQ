import { publicBookingStyle } from "@/lib/booking/public-style";
import { effectiveBookingLocation } from "@/lib/booking/location";
import {
  validateBookingLocation,
  validateDuration,
  validatePayment,
  validateTimezone,
  validateVisibleDays,
} from "@/lib/booking/validation";
import type { BookingLocation, BookingPage, BookingService, IntakeField } from "@/types/booking";
import type { CheckoutThemeId } from "@/types/checkout-pages";
import type { CalendarEvent, EventStatus } from "@/types/events";

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
 * `location` carries the type and, for in-person / they-call pages, the
 * address or number the business chose to show — never the meeting link.
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
  /** Where the meeting happens. Null: not set. */
  location: BookingLocation | null;
  /** Whether the booker's phone gets booking texts: shows the consent line under the phone field. Only this boolean, never the reminder settings. */
  textsBooker: boolean;
}

export interface PublicBookingBranding {
  name: string;
  logoUrl: string | null;
  accentColor: string | null;
}

export interface PublicEventData {
  status: EventStatus;
  title: string;
  pageName: string;
  bookingPageStatus: "draft" | "published";
  timezone: string;
  durationMinutes: number;
  paymentLinkUrl: string | null;
  paymentAmount: number | null;
  paymentCurrency: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicServices(value: unknown): BookingService[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.durationMinutes !== "number" ||
      !validateDuration(item.durationMinutes).ok ||
      (item.description !== null && item.description !== undefined && typeof item.description !== "string")
    ) {
      return [];
    }
    return [{
      id: item.id,
      name: item.name,
      durationMinutes: item.durationMinutes,
      description: item.description ?? null,
    }];
  });
}

function publicIntakeFields(value: unknown): IntakeField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.label !== "string" ||
      !["text", "textarea", "select"].includes(String(item.type)) ||
      typeof item.required !== "boolean"
    ) {
      return [];
    }
    const options = Array.isArray(item.options)
      ? item.options.filter((option): option is string => typeof option === "string")
      : null;
    return [{
      id: item.id,
      label: item.label,
      type: item.type as IntakeField["type"],
      required: item.required,
      options,
    }];
  });
}

function publicPayment(value: unknown): PublicBookingPageData["payment"] {
  const checked = validatePayment(value);
  return checked.ok ? checked.value : null;
}

function publicPaymentLinkUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "paypal.me" && !url.username && !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}

/** The page's location, re-checked as the editor saves it; a bad one is dropped. */
function publicLocation(doc: BookingPage): BookingLocation | null {
  const checked = validateBookingLocation(effectiveBookingLocation(doc));
  return checked.ok ? checked.value : null;
}

function publicTimezone(value: unknown): string {
  const checked = validateTimezone(value);
  return checked.ok ? checked.value : "UTC";
}

function publicDuration(value: unknown, fallback: number): number {
  const checked = validateDuration(value);
  return checked.ok ? checked.value : fallback;
}

function publicVisibleDays(value: unknown): number {
  const checked = validateVisibleDays(value);
  return checked.ok ? checked.value : 14;
}

/** Complete stored-data boundary for the interactive /e client payload. */
export function publicEventData(
  event: CalendarEvent,
  page: BookingPage | null,
  startAt: Date,
  endAt: Date,
): PublicEventData {
  const title = typeof event.title === "string" ? event.title : "Meeting";
  const pageName = typeof page?.name === "string" ? page.name : title;
  const serviceName = typeof event.serviceName === "string" ? event.serviceName : null;
  const pageDuration = publicDuration(page?.durationMinutes, 30);
  const actualDuration = publicDuration(Math.round((endAt.getTime() - startAt.getTime()) / 60_000), pageDuration);
  const validStatuses: EventStatus[] = ["scheduled", "awaiting_payment", "completed", "cancelled", "no_show"];
  const payment = publicPayment({
    amount: event.paymentAmount,
    currency: event.paymentCurrency,
    description: null,
    holdHours: 24,
  });

  return {
    status: validStatuses.includes(event.status as EventStatus) ? (event.status as EventStatus) : "scheduled",
    title,
    pageName: serviceName ? `${pageName} (${serviceName})` : pageName,
    bookingPageStatus: page === null || page.status === "published" ? "published" : "draft",
    timezone: publicTimezone(page?.timezone),
    durationMinutes: serviceName ? actualDuration : pageDuration,
    paymentLinkUrl: publicPaymentLinkUrl(event.paymentLinkUrl),
    paymentAmount: payment?.amount ?? null,
    paymentCurrency: payment?.currency ?? null,
  };
}

export function publicBookingPage(doc: BookingPage, canonicalSlug: string): PublicBookingPageData {
  const isServicePage = doc.calendarType === "service";
  return {
    slug: canonicalSlug,
    name: typeof doc.name === "string" ? doc.name : "",
    description: typeof doc.description === "string" ? doc.description : "",
    durationMinutes: publicDuration(doc.durationMinutes, 30),
    timezone: publicTimezone(doc.timezone),
    visibleDays: publicVisibleDays(doc.visibleDays),
    isServicePage,
    services: isServicePage ? publicServices(doc.services) : [],
    intakeFields: publicIntakeFields(doc.intakeFields),
    payment: publicPayment(doc.payment),
    themePreset: publicBookingStyle(doc).themePreset,
    location: publicLocation(doc),
    textsBooker: doc.smsRemindersEnabled === true,
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
