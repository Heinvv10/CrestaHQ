/**
 * Marker syntax for the AI booking tools (booking-tools.ts): finding a
 * marker, reading its attributes, offered-time keys, and stripping leftovers
 * before a reply reaches a person. Pure, no I/O.
 *
 * Running is strict: "[[" + keyword + whitespace or "]]", then either nothing
 * or at least one key="…" before the closing "]]" ("[[Book now]]",
 * "[[book-x]]" never run). Stripping is deliberately broad (see
 * stripBookingMarkers): anything that starts like a marker is removed, so a
 * sloppy or cut-off one can't reach a person.
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
const ATTR_RE = /(?:^|\s)[a-z][a-z0-9_-]*\s*=\s*"[^"]*"/i;

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

// Whitespace and characters that render as nothing (format characters, soft
// hyphen, combining grapheme joiner, Mongolian vowel separator, braille
// blank, NEL, Hangul fillers), so they can't hide an opener.
const INVISIBLE = "[\\s\\p{Cf}\\u00AD\\u034F\\u180E\\u2800\\u0085\\u3164\\u115F\\uFFA0]";
// Strip openers: "[[", optional invisibles, a keyword, then a Hangul filler
// (a letter that renders as nothing) or anything but a letter or digit, or the end.
const STRIP_OPENER = `\\[\\[${INVISIBLE}*(?:slots|book|reschedule|cancel)(?=[\\u3164\\u115F\\uFFA0]|[^\\p{L}\\p{N}]|$)`;
const MAX_STRIP_PASSES = 3;
/** A reply cut off inside an opener: "Hi [[", "Hi [[bo". */
const TRUNCATED_OPENER_RE = new RegExp(
  `^\\[\\[${INVISIBLE}*(?:s(?:l(?:o(?:ts?)?)?)?|b(?:o(?:ok?)?)?|r(?:e(?:s(?:c(?:h(?:e(?:d(?:u(?:le?)?)?)?)?)?)?)?)?|c(?:a(?:n(?:c(?:el?)?)?)?)?)?$`,
  "iu",
);

/**
 * Past a removed marker: a "]]" before the next "[[" or line break closes it
 * too (a "]]" inside a value, a stray "]]"). Returns where kept text resumes.
 */
function skipOrphanCloses(text: string, from: number): number {
  let resume = from;
  for (let j = from; j < text.length; j++) {
    if (text.startsWith("]]", j)) {
      resume = j + 2;
      j++;
    } else if (text[j] === "\n" || text.startsWith("[[", j)) {
      break;
    }
  }
  return resume;
}

/**
 * Removes anything that starts like a marker, through the next "]]" (inner
 * openers go with it) or to the end of the text, plus orphan "]]" right after
 * it and an opener cut off at the very end. Each pass is linear; passes repeat
 * while removing one marker exposes another ("[[bo[[slots]]ok"), at most
 * MAX_STRIP_PASSES, then everything from the first remaining opener goes. No
 * double space is left where a marker was, and a code fence the strip left
 * empty goes. Broad on purpose: prose like "[[Book now]]" is removed too,
 * which beats a marker leaking to a person.
 */
export function stripBookingMarkers(text: string): string {
  let current = text;
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
    const next = stripPass(current);
    if (next === current) break;
    current = next;
  }
  if (stripPass(current) !== current) {
    const first = new RegExp(STRIP_OPENER, "iu").exec(current);
    current = dropTruncatedTail(first ? current.slice(0, first.index) : stripPass(current));
  }
  return current === text ? text : dropEmptyFences(current);
}

/** One linear pass; returns `text` itself when nothing was removed. */
function stripPass(text: string): string {
  const opener = new RegExp(STRIP_OPENER, "giu");
  const out: string[] = [];
  let from = 0;
  let removed = false;
  let changed = false;
  const keep = (chunk: string) => {
    const last = out[out.length - 1];
    const lastChar = last ? last[last.length - 1] : "";
    const piece =
      removed && (lastChar === " " || lastChar === "\t") ? chunk.replace(/^[ \t]+/, "") : chunk;
    if (!piece) return;
    out.push(piece);
    removed = false;
  };
  for (;;) {
    opener.lastIndex = from;
    const m = opener.exec(text);
    if (!m) {
      keep(text.slice(from));
      break;
    }
    keep(text.slice(from, m.index));
    removed = true;
    changed = true;
    const close = text.indexOf("]]", m.index + m[0].length);
    if (close === -1) break;
    from = skipOrphanCloses(text, close + 2);
  }
  const joined = out.join("");
  const result = dropTruncatedTail(joined);
  return changed || result !== joined ? result : text;
}

/** Drops every opener cut off at the very end ("Hi [[bo[[bo" -> "Hi "). */
function dropTruncatedTail(text: string): string {
  let result = text;
  for (;;) {
    const tail = result.lastIndexOf("[[");
    if (tail === -1 || !TRUNCATED_OPENER_RE.test(result.slice(tail))) return result;
    result = result.slice(0, tail);
  }
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
