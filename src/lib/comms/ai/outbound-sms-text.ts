import { segmentInfo } from "@/lib/comms/sms-segments";

/**
 * Shaping and the output check for the AI's first text (outbound-sms.ts).
 * The model's words are untrusted: a poisoned contact field, the website KB or
 * the model itself can steer them. So the check is an ALLOW-list: anything
 * that could carry a contact route — an address, a domain, an email, a phone
 * number, however it is spelled — refuses the send unless the business wrote
 * that exact token in the instruction (or it is the business name).
 */

/** Dot, colon, slash and at look-alikes NFKC leaves alone. */
const LOOKALIKE_PUNCT: Record<string, string> = {
  "\u3002": ".", "\uFF61": ".", "\u2024": ".", "\u2027": ".", "\u00B7": ".", "\u2219": ".",
  "\u22C5": ".", "\u30FB": ".", "\u0589": ".", "\u06D4": ".", "\u0701": ".", "\u0702": ".",
  "\uFE52": ".", "\u2E33": ".", "\u2E31": ".",
  "\u2236": ":", "\uA789": ":", "\uFE55": ":", "\u02D0": ":",
  "\u2044": "/", "\u2215": "/", "\u29F8": "/", "\u2571": "/",
  "\uFE6B": "@",
};
const LOOKALIKE_PUNCT_RE = new RegExp(`[${Object.keys(LOOKALIKE_PUNCT).join("")}]`, "g");

/** Cyrillic and Greek letters that read as Latin, folded for the checks only. */
const LOOKALIKE_LETTERS: Record<string, string> = {
  "\u0430": "a", "\u0432": "b", "\u0435": "e", "\u043A": "k", "\u043C": "m", "\u043D": "h", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0442": "t", "\u0443": "y",
  "\u0445": "x", "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u04BB": "h", "\u04CF": "l", "\u051B": "q", "\u051D": "w",
  "\u03B1": "a", "\u03B5": "e", "\u03B9": "i", "\u03BA": "k", "\u03BD": "v", "\u03BF": "o", "\u03C1": "p", "\u03C4": "t", "\u03C5": "u", "\u03C7": "x",
};
const LOOKALIKE_LETTERS_RE = new RegExp(`[${Object.keys(LOOKALIKE_LETTERS).join("")}]`, "gi");

/**
 * NFKC, then no format characters (zero-width, bidi, soft hyphen), no astral
 * characters (emoji are not allowed anyway, and they break segment counts),
 * look-alike punctuation as the real thing, GSM-friendly quotes and dashes,
 * one line. Applied to the text that is sent, so the check sees what goes out.
 */
export function normaliseSmsText(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\p{Cf}\u00AD]/gu, "")
    .replace(/[\u{10000}-\u{10FFFF}]/gu, "")
    .replace(LOOKALIKE_PUNCT_RE, (c) => LOOKALIKE_PUNCT[c])
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\p{Cc}\p{Z}]+/gu, " ")
    .trim();
}

/** The model's raw reply → the body, before the opt-out strip. */
export function cleanOpener(raw: string): string {
  return normaliseSmsText(raw)
    // Markers, including one the model never closed.
    .replace(/\[\[[\s\S]*?\]\]/g, "")
    .replace(/\[\[[\s\S]*$/, "")
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
}

/** A whole sentence that is an opt-out instruction: "Reply STOP to opt out.",
 *  "To opt out, reply STOP.", "STOP to unsubscribe". Bounded, so no backtracking blow-up. */
const OPT_OUT_SENTENCE =
  /^(?:to (?:opt[\s-]?out|unsubscribe|stop)[^,.!?]{0,40},\s*)?(?:reply|text|send|respond|sms|message|msg)\b[^.!?]{0,40}\bstop\b[^.!?]{0,80}[.!?]*$|^stop\b[^.!?]{0,80}\b(?:opt[\s-]?out|unsubscribe|end|cancel)\b[^.!?]{0,40}[.!?]*$/i;

/** Drops sentences that are an opt-out instruction; other sentences are kept whole. */
export function stripOptOutSentences(text: string): string {
  // A sentence ends at . ! or ? followed by a space, so a dot inside a word
  // (an allowed link) never splits one.
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s && !OPT_OUT_SENTENCE.test(s))
    .join(" ");
}

/** Opt-out wording left in the body: ours is the only one, so this refuses. */
export function hasOptOutWording(text: string): boolean {
  return /(?<![\w-])stop(?![\w-])/i.test(text) || /\bopt.?out\b/i.test(text) || /unsubscribe/i.test(text);
}

/** Patterns that can carry a contact route. Each match is refused unless its
 *  whole tokens are allowed. */
const ROUTE_PATTERNS: RegExp[] = [
  // A phone number: 7+ digits, ignoring spaces, dots, dashes and brackets.
  /\d(?:[\s.\-()]*\d){6,}/g,
  /tel:/gi,
  /@/g,
  // A dot, colon or slash inside a word: domains, IPs, paths, times, e.g.
  /\S[.:/]\S/g,
  // Spaced out: "evil . com", "evil .com", "evil. com".
  /\S\s+[.:/]+\s*\S/g,
  /[.:/]\s+\p{Ll}/gu,
  // Spelled out: "evil dot com", "help (at) evil".
  /\w\s+dot\s+\w/gi,
  /[[({]\s*(?:dot|at|[.:/@])\s*[\])}]/gi,
  /hxxp/gi,
];

/** Look-alike letters as Latin, case kept (one pattern below is case-sensitive). */
const fold = (s: string) =>
  s.replace(LOOKALIKE_LETTERS_RE, (c) => {
    const latin = LOOKALIKE_LETTERS[c.toLowerCase()] ?? c;
    return c === c.toLowerCase() ? latin : latin.toUpperCase();
  });
const trimToken = (t: string) => t.replace(/^[("'[{]+/, "").replace(/[.,!?;:)"'\]}]+$/, "");

interface Token { text: string; start: number; end: number }
function tokens(text: string): Token[] {
  return [...text.matchAll(/\S+/g)].map((m) => ({
    text: trimToken(m[0]).toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/**
 * The route-like tokens in `text` that none of `allowedSources` contains as
 * the same whole token sequence (never a substring of a token). Both sides are
 * normalised the same way first. Empty = sendable.
 */
export function refusedTokens(text: string, allowedSources: string[]): string[] {
  const checked = fold(normaliseSmsText(text));
  const own = tokens(checked);
  const allowed = allowedSources.map((s) => tokens(fold(normaliseSmsText(s))).map((t) => t.text));
  const refused: string[] = [];
  for (const re of ROUTE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of checked.matchAll(re)) {
      const from = m.index;
      const to = from + m[0].length;
      const seq = own.filter((t) => t.end > from && t.start < to).map((t) => t.text);
      const ok = seq.length > 0 && allowed.some((a) => containsRun(a, seq));
      if (!ok) refused.push(seq.join(" ") || m[0]);
    }
  }
  return [...new Set(refused)];
}

function containsRun(haystack: string[], run: string[]): boolean {
  for (let i = 0; i + run.length <= haystack.length; i++) {
    if (run.every((t, j) => haystack[i + j] === t)) return true;
  }
  return false;
}

/** Segments as the carrier bills them: UCS-2 counts UTF-16 units, not code points. */
export function exactSmsSegments(text: string): number {
  const info = segmentInfo(text);
  if (info.encoding === "GSM-7") return info.segments;
  const n = text.length;
  if (n === 0) return 0;
  return n <= 70 ? 1 : Math.ceil(n / 67);
}

/** Drops a trailing word or sentence until the text fits the segment budget. */
function fitSegments(text: string, maxSegments: number): string {
  let out = text;
  while (out && exactSmsSegments(out) > maxSegments) {
    const sentenceEnd = Math.max(
      out.lastIndexOf(". ", out.length - 2),
      out.lastIndexOf("? ", out.length - 2),
      out.lastIndexOf("! ", out.length - 2),
    );
    const cut =
      sentenceEnd > out.length * 0.5
        ? out.slice(0, sentenceEnd + 1)
        : out.slice(0, Math.max(0, out.lastIndexOf(" "))).trimEnd();
    out = cut === out ? out.slice(0, -1) : cut;
  }
  return out;
}

/** Trims the body (never the suffix) until both fit together. */
export function fitWithSuffix(body: string, suffix: string, maxSegments: number): string {
  let fitted = fitSegments(body, maxSegments);
  while (fitted && exactSmsSegments(`${fitted}${suffix}`) > maxSegments) {
    fitted = fitSegments(fitted.slice(0, -1), maxSegments);
  }
  return fitted;
}
