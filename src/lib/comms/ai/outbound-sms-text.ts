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

/** A digit spelled out, as a whole word. */
const DIGIT_WORD = String.raw`(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)(?!\p{L})`;

/** Patterns that can carry a contact route. Each match is refused unless its
 *  whole tokens are allowed. */
const ROUTE_PATTERNS: RegExp[] = [
  // A phone number: 7+ digits, whatever non-letters sit between them.
  /\d(?:[^\p{L}]{0,3}\d){6,}/gu,
  // ...or spelled out ("oh eight two one…"), digits and words mixed.
  new RegExp(String.raw`(?<!\p{L})(?:\d|${DIGIT_WORD})(?:[^\p{L}\d]{0,3}(?:\d|${DIGIT_WORD})){6,}`, "giu"),
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

const trimToken = (t: string) => t.replace(/^[("'[{]+/, "").replace(/[.,!?;:)"'\]}]+$/, "");

/** A token as compared: scheme and host are case-insensitive, so lowercased;
 *  a path, query or fragment is not, so it is kept exactly. */
function comparable(token: string): string {
  const head = token.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*/i)?.[0] ?? "";
  return head.toLowerCase() + token.slice(head.length);
}

interface Token { text: string; start: number; end: number }
function tokens(text: string): Token[] {
  return [...text.matchAll(/\S+/g)].map((m) => ({
    text: comparable(trimToken(m[0])),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** A letter outside the Latin script: a look-alike domain or word that would
 *  be compared as something it is not. */
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
/** A digit other than 0-9 (Arabic-Indic, Devanagari and so on): a phone
 *  number the digit-run rules can't count. */
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/u;

/**
 * The route-like tokens in `text` that none of `allowedSources` contains as
 * the same whole token sequence (never a substring of a token), compared
 * exactly: a domain spelled with a Cyrillic look-alike never matches the Latin
 * one the business wrote. Any non-Latin letter refuses the text outright —
 * look-alikes included, so a "dot" spelled with a Cyrillic o is caught too —
 * except inside `exactNames` (the business and first name, matched exactly),
 * and so does any non-ASCII digit. Empty = sendable.
 */
export function refusedTokens(text: string, allowedSources: string[], exactNames: string[] = []): string[] {
  const sent = normaliseSmsText(text);
  const own = tokens(sent);
  const allowed = allowedSources.map((s) => tokens(normaliseSmsText(s)).map((t) => t.text));
  const refused: string[] = [];
  let unnamed = sent;
  for (const name of exactNames.map(normaliseSmsText).filter(Boolean)) unnamed = unnamed.split(name).join(" ");
  if (NON_LATIN_LETTER.test(unnamed)) refused.push("non_latin_letters");
  if (NON_ASCII_DIGIT.test(sent)) refused.push("non_ascii_digits");
  for (const re of ROUTE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of sent.matchAll(re)) {
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
