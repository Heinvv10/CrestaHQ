/**
 * Marker syntax for the AI booking tools (booking-tools.ts): finding a
 * marker, reading its attributes, offered-time keys, and stripping leftovers
 * before a reply reaches a person. Pure, no I/O.
 */

export type BookingMarkerKind = "slots" | "book" | "reschedule" | "cancel";

/**
 * Only the head of a reply is scanned for a marker. A real marker is short;
 * the lazy patterns cost the square of the text length on a reply with many
 * unclosed "[[book".
 */
export const MAX_SCAN_CHARS = 16_000;

// Lazy up to the first "]]" so a stray "]" inside an answer can't hide a marker.
const MARKER_RE: Record<BookingMarkerKind, RegExp> = {
  slots: /\[\[\s*slots\b([\s\S]*?)\]\]/i,
  book: /\[\[\s*book\b([\s\S]*?)\]\]/i,
  reschedule: /\[\[\s*reschedule\b([\s\S]*?)\]\]/i,
  cancel: /\[\[\s*cancel\b([\s\S]*?)\]\]/i,
};

/**
 * The first marker of `kind` in `text`. `whole` = the trimmed text is that
 * marker and nothing else.
 */
export function findMarker(
  text: string,
  kind: BookingMarkerKind,
): { attrs: string; whole: boolean } | null {
  const m = MARKER_RE[kind].exec(text);
  if (!m) return null;
  return { attrs: m[1] ?? "", whole: m[0] === text.trim() };
}

/** key="value" pairs, keys lowercased, values trimmed. */
export type MarkerAttrs = ReadonlyMap<string, string>;

/** Null when a key appears twice: which value the model meant is unknowable. */
export function parseMarkerAttrs(raw: string): MarkerAttrs | null {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(/(?:^|\s)([a-z][a-z0-9_-]*)\s*=\s*"([^"]*)"/gi)) {
    const key = m[1].toLowerCase();
    if (out.has(key)) return null;
    out.set(key, m[2].trim());
  }
  return out;
}

export function attr(attrs: MarkerAttrs, key: string): string {
  return attrs.get(key) ?? "";
}

/** Canonical ISO for set lookups; unparseable input passes through unchanged. */
export function normalizeIso(raw: string): string {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

/** A start="…" value as the canonical instant, or null when it isn't a date. */
export function parseStartIso(raw: string): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Offered-time keys. A reschedule offer can't be used to make a new booking
 * and vice versa, and a time offered for one host (or pooled, "*") can't be
 * booked for another.
 */
export function bookOfferKey(pageSlug: string, hostUid: string | null, iso: string): string {
  return `book:${pageSlug}|${hostUid ?? "*"}|${normalizeIso(iso)}`;
}
export function rescheduleOfferKey(eventId: string, iso: string): string {
  return `move:${eventId}|${normalizeIso(iso)}`;
}

/**
 * Removes every booking marker, and a trailing unclosed one with everything
 * after it. One forward pass (indexOf for each close), so linear in the text.
 */
export function stripBookingMarkers(text: string): string {
  const opener = /\[\[\s*(?:slots|book|reschedule|cancel)\b/gi;
  let out = "";
  let from = 0;
  for (;;) {
    opener.lastIndex = from;
    const m = opener.exec(text);
    if (!m) return out + text.slice(from);
    out += text.slice(from, m.index);
    const close = text.indexOf("]]", m.index + m[0].length);
    if (close === -1) return out;
    from = close + 2;
  }
}
