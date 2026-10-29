/**
 * Marker syntax for the AI booking tools (booking-tools.ts): finding a
 * marker, reading its attributes, offered-time keys, and stripping leftovers
 * before a reply reaches a person. Pure, no I/O.
 *
 * A marker is "[[" + keyword + whitespace or "]]", then either nothing or at
 * least one key="…" before the closing "]]". "[[Book now]]", "[[booking]]"
 * and "[[book-x]]" are prose, never markers.
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
  slots: /\[\[\s*slots(?=[\s\]])([\s\S]*?)\]\]/gi,
  book: /\[\[\s*book(?=[\s\]])([\s\S]*?)\]\]/gi,
  reschedule: /\[\[\s*reschedule(?=[\s\]])([\s\S]*?)\]\]/gi,
  cancel: /\[\[\s*cancel(?=[\s\]])([\s\S]*?)\]\]/gi,
};
const OPENER = "\\[\\[\\s*(?:slots|book|reschedule|cancel)(?=[\\s\\]])";
const ATTR_RE = /(?:^|\s)[a-z][a-z0-9_-]*\s*=\s*"[^"]*"/i;
/** A key=" whose value may have been cut off (a reply stopped at max tokens). */
const ATTR_START_RE = /(?:^|\s)[a-z][a-z0-9_-]*\s*=\s*"/i;
const MAX_STRIP_PASSES = 8;

function isMarkerBody(body: string): boolean {
  return body.trim() === "" || ATTR_RE.test(body);
}

/**
 * The first marker of `kind` in the reply's head. `whole` = the trimmed FULL
 * reply is that marker and nothing else (never true past MAX_SCAN_CHARS).
 */
export function findMarker(
  text: string,
  kind: BookingMarkerKind,
): { attrs: string; whole: boolean } | null {
  const re = new RegExp(MARKER_RE[kind].source, "gi");
  for (const m of text.slice(0, MAX_SCAN_CHARS).matchAll(re)) {
    const attrs = m[1] ?? "";
    if (isMarkerBody(attrs)) return { attrs, whole: m[0] === text.trim() };
  }
  return null;
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

/**
 * Visitor- or model-supplied values quoted into a prompt or a tool result
 * can't close a quote, forge a marker, or start a new line (any Unicode line
 * break or control character).
 */
export function promptSafe(value: string | null | undefined): string {
  return (value ?? "").replace(/[\p{Cc}\p{Zl}\p{Zp}"[\]]/gu, "").trim().slice(0, 120);
}

/** Canonical ISO for set lookups; unparseable input passes through unchanged. */
export function normalizeIso(raw: string): string {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

const STRICT_ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/**
 * A start="…" value as the canonical instant. Only ISO 8601 with seconds
 * optional and an explicit Z or ±hh:mm offset; a value that doesn't round-trip
 * (02-30, T24:00, +15:00) is null rather than rolled over.
 */
export function parseStartIso(raw: string): string | null {
  const m = STRICT_ISO_RE.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const s = Number(m[6] ?? 0);
  const ms = Number((m[7] ?? "0").padEnd(3, "0"));
  const offH = m[8] ? 0 : Number(m[10]);
  const offM = m[8] ? 0 : Number(m[11]);
  if (offH > 14 || offM > 59) return null;
  const local = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  if (
    local.getUTCFullYear() !== y ||
    local.getUTCMonth() !== mo - 1 ||
    local.getUTCDate() !== d ||
    local.getUTCHours() !== h ||
    local.getUTCMinutes() !== mi ||
    local.getUTCSeconds() !== s
  ) {
    return null;
  }
  const sign = m[9] === "-" ? -1 : 1;
  return new Date(local.getTime() - sign * (offH * 60 + offM) * 60_000).toISOString();
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

/** Appends kept text; right after a removed marker, no double space is left. */
function keep(out: string, chunk: string, afterRemoval: boolean): string {
  return afterRemoval && /[ \t]$/.test(out) ? out + chunk.replace(/^[ \t]+/, "") : out + chunk;
}

/** One forward pass; each segment up to a "]]" is examined once, so linear. */
function stripOnce(text: string): string {
  const opener = new RegExp(OPENER, "gi");
  let out = "";
  let from = 0;
  let removed = false;
  for (;;) {
    opener.lastIndex = from;
    const m = opener.exec(text);
    if (!m) return keep(out, text.slice(from), removed);
    const bodyStart = m.index + m[0].length;
    const close = text.indexOf("]]", bodyStart);
    if (close === -1) {
      // Unclosed: cut off at max tokens only if it already has a key=". Cut
      // from the last opener before that key (earlier ones are prose).
      const attrAt = text.slice(bodyStart).search(ATTR_START_RE);
      if (attrAt === -1) return keep(out, text.slice(from), removed);
      // +1 keeps the whitespace before the key, which the opener's lookahead needs.
      const head = text.slice(0, bodyStart + attrAt + 1);
      let cut = m.index;
      for (const o of head.slice(m.index).matchAll(new RegExp(OPENER, "gi"))) {
        cut = m.index + (o.index ?? 0);
      }
      return keep(out, text.slice(from, cut), removed);
    }
    const body = text.slice(bodyStart, close);
    let start = m.index;
    if (!isMarkerBody(body)) {
      // Only an opener with nothing but whitespace before this "]]" can still
      // be a marker inside a non-marker span ("[[book now [[slots ]]").
      const inner = new RegExp(`${OPENER}\\s*$`, "i").exec(body);
      if (!inner) {
        out = keep(out, text.slice(from, close + 2), removed);
        removed = false;
        from = close + 2;
        continue;
      }
      start = bodyStart + inner.index;
    }
    out = keep(out, text.slice(from, start), removed);
    removed = true;
    from = close + 2;
  }
}

/**
 * Removes every booking marker, and a trailing marker cut off at max tokens.
 * Repeats until nothing changes, so a marker formed by removing a nested one
 * goes too; after MAX_STRIP_PASSES the remaining openers are removed outright.
 * A code fence the strip left empty is dropped.
 */
export function stripBookingMarkers(text: string): string {
  let current = text;
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
    const next = stripOnce(current);
    if (next === current) break;
    current = next;
    if (pass === MAX_STRIP_PASSES - 1) current = current.replace(new RegExp(OPENER, "gi"), "");
  }
  return current === text ? text : dropEmptyFences(current);
}

/** Removes ``` blocks holding only whitespace (a fence that wrapped a marker). */
function dropEmptyFences(text: string): string {
  const out: string[] = [];
  let openAt = -1;
  for (const line of text.split("\n")) {
    if (!/^\s*```/.test(line)) {
      out.push(line);
    } else if (openAt === -1) {
      openAt = out.length;
      out.push(line);
    } else {
      if (out.slice(openAt + 1).every((l) => l.trim() === "")) out.length = openAt;
      else out.push(line);
      openAt = -1;
    }
  }
  return out.join("\n");
}
