import type {
  BookingLocation,
  BookingLocationType,
  BookingPage,
} from "@/types/booking";

// Client-safe helpers for a booking page's location (editor, public page,
// book route, AI agents). One source for labels and the event's location text.

export const BOOKING_LOCATION_OPTIONS: {
  type: BookingLocationType;
  label: string;
  hint: string;
}[] = [
  { type: "video_link", label: "Video call (Zoom, Teams…)", hint: "Paste the meeting link below; it's sent with every confirmation." },
  { type: "google_meet", label: "Google Meet (unique link per booking)", hint: "Needs Calendar sync switched on for this workspace and every host on this page connected (Settings → Calendar sync)." },
  { type: "in_person", label: "In person, at our place", hint: "Enter the address shown to the booker." },
  { type: "we_call", label: "Phone call, we call them", hint: "The booker's phone number is collected when they book." },
  { type: "they_call", label: "Phone call, they call us", hint: "Enter the number the booker should call." },
  { type: "their_address", label: "At their place (on-site visit)", hint: "The booker enters their address when they book." },
];

const TYPES = new Set<BookingLocationType>(BOOKING_LOCATION_OPTIONS.map((o) => o.type));

export function isBookingLocationType(v: unknown): v is BookingLocationType {
  return typeof v === "string" && TYPES.has(v as BookingLocationType);
}

/** Longest address the business or the booker may give. */
export const LOCATION_ADDRESS_MAX = 300;

/**
 * An address or phone number as stored and shown: plain text on one line.
 * It reaches emails, the .ics invite, reminders and Google, so no markup
 * characters, no control characters (C0, DEL, C1 — NEL included) and no
 * Unicode line / paragraph separators: anything a reader could take as a
 * line break would start a new .ics property.
 */
export function isPlainLocationText(v: string): boolean {
  return !/[<>\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v);
}

/**
 * The booker's "Where:" line when a Google Meet booking has no link to send
 * (no room could be made in time, and the page has no fallback link).
 */
export function meetLinkToFollow(locationText: string): string {
  return `${locationText} (the joining link will follow)`;
}

/** Types where the business types a value (address / phone number). */
export function locationNeedsValue(type: BookingLocationType): "address" | "phone" | null {
  if (type === "in_person") return "address";
  if (type === "they_call") return "phone";
  return null;
}

/** Types where the booker must give something extra when booking. */
export function locationNeedsFromBooker(type: BookingLocationType): "address" | "phone" | null {
  if (type === "their_address") return "address";
  if (type === "we_call") return "phone";
  return null;
}

/**
 * The page's location, deriving one for older pages saved before the field
 * existed (Google Meet ticked, or a meeting URL set). Null = not set.
 */
export function effectiveBookingLocation(
  page: Pick<BookingPage, "location" | "googleMeet" | "meetingUrl">,
): BookingLocation | null {
  if (page.location && isBookingLocationType(page.location.type)) return page.location;
  if (page.googleMeet) return { type: "google_meet", value: null };
  if (page.meetingUrl) return { type: "video_link", value: null };
  return null;
}

/** Short line for the public page header and the AI, e.g. "Phone call, we'll call you". */
export function describeBookingLocation(location: BookingLocation | null): string | null {
  if (!location) return null;
  switch (location.type) {
    case "video_link":
      return "Video call (link sent with your confirmation)";
    case "google_meet":
      return "Google Meet (link sent with your confirmation)";
    case "in_person":
      return location.value ? `In person at ${location.value}` : "In person";
    case "we_call":
      return "Phone call, we'll call you";
    case "they_call":
      return location.value ? `Phone call, please call ${location.value}` : "Phone call";
    case "their_address":
      return "At your address";
  }
}

/**
 * Text stored on the event's `location` (calendar, emails, reminders, invite).
 * For video types the join link itself travels in `meetingUrl`; this is just
 * the "Where:" line.
 */
export function eventLocationText(
  location: BookingLocation | null,
  booker: { phone?: string | null; address?: string | null },
): string {
  if (!location) return "";
  // The booker's own values are only used as plain one-line text.
  const plain = (v: string | null | undefined) => (v && isPlainLocationText(v) ? v : null);
  booker = { phone: plain(booker.phone), address: plain(booker.address) };
  switch (location.type) {
    case "video_link":
      return "Video call";
    case "google_meet":
      return "Google Meet video call";
    case "in_person":
      return location.value ?? "";
    case "we_call":
      return booker.phone ? `Phone call: we'll call ${booker.phone}` : "Phone call: we'll call you";
    case "they_call":
      return location.value ? `Phone call: call ${location.value}` : "Phone call";
    case "their_address":
      return booker.address ? `At your address: ${booker.address}` : "At your address";
  }
}
