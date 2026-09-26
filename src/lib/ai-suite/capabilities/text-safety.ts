/**
 * Text an approver or an agent reads, kept honest: which characters a stored
 * value may not carry, how agent input is normalised before that check, and
 * how stored values print on one line.
 */

/** Control (Cc, incl. NEL), format (Cf), line / paragraph separators, and
 *  every Default_Ignorable code point — the characters that render as
 *  nothing, assigned or not (fillers, variation selectors, tag characters…)
 *  — plus the blank braille cell U+2800, which is visible-as-nothing but not
 *  default-ignorable. By property, not by list, so new ones are covered.
 *  Also private-use (Co), unassigned (Cn) and lone-surrogate (Cs) code
 *  points, which won't render. Refused in stored text an approver reads (a
 *  newline could fake a preview row, an invisible one hide text or carry
 *  data). U+FE0F is default-ignorable too: only a real presentation
 *  selector (EMOJI_PRESENTATION) is let through. Space separators (NBSP,
 *  U+202F, U+3000…) are not refused — they show as spaces — but agentText
 *  and messageBody turn them into plain spaces first. */
export const UNSAFE_TEXT_RE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cn}\p{Cs}\u2800]/u;

/** The one refusal message for UNSAFE_TEXT_RE, naming the cause. */
export const UNSAFE_TEXT_MESSAGE =
  "contains characters that can't be shown safely (control, invisible, bidi, private-use or unassigned)";

/** Every space separator (NBSP, thin, U+202F, U+3000…) as a plain space. */
export const plainSpaces = (v: string) => v.replace(/\p{Zs}/gu, " ");
/** What oneLine removes outright: the invisible set (a presentation
 *  selector excepted, see oneLine). */
const STRIP_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu;
/** A U+FE0F that is really an emoji presentation selector: once, right after
 *  an emoji, or in a keycap (digit / # / * + FE0F + U+20E3). Any other FE0F —
 *  after a letter, stacked, leading — is an invisible character. */
const PRESENTATION_SOURCE = "(?<=\\p{Extended_Pictographic})\\ufe0f(?!\\ufe0f)|(?<=[0-9#*])\\ufe0f(?=\\u20e3)";
const EMOJI_PRESENTATION = new RegExp(PRESENTATION_SOURCE, "gu");
const PRESENTATION_AT = new RegExp(PRESENTATION_SOURCE, "uy");

/** A ZWNJ / ZWJ that joins two letters, marks or emoji — Persian names,
 *  family emoji sequences (U+1F468 U+200D U+1F469 …) — is text, not a trick. */
const JOINER_IN_WORD =
  /(?<=[\p{L}\p{M}\p{Extended_Pictographic}])[\u200c\u200d](?=[\p{L}\p{M}\p{Extended_Pictographic}])/gu;

/** UNSAFE_TEXT_RE, except a ZWNJ / ZWJ between letters, marks or emoji. */
export function hasUnsafeText(value: string): boolean {
  return UNSAFE_TEXT_RE.test(value.replace(JOINER_IN_WORD, "").replace(EMOJI_PRESENTATION, ""));
}

/**
 * An agent-supplied field, trimmed. For `address` only, line breaks are
 * folded to ", " first — people store multi-line addresses (the forms use a
 * textarea) — so the unsafe-text check that follows still refuses every
 * other control character, and a newline in any other field.
 */
export function agentText(key: string, value: string): string {
  const v = plainSpaces(value).trim();
  return key === "address" ? v.replace(/\s*[\r\n]+\s*/g, ", ") : v;
}

/** A stored value on one line, for list output and previews (legacy or
 *  externally supplied data — a WhatsApp profile name, a web-chat visitor —
 *  may hold separators, control, zero-width or bidi characters). */
export function oneLine(value: unknown): string {
  return String(value ?? "")
    .replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    // A stacked run shows as (at most) one selector.
    .replace(/\ufe0f+/gu, "\ufe0f")
    .replace(STRIP_RE, (ch, at: number, whole: string) => {
      if (ch !== "\ufe0f") return "";
      PRESENTATION_AT.lastIndex = at;
      return PRESENTATION_AT.test(whole) ? ch : "";
    })
    .trim();
}

/** A ZWJ inside an emoji sequence (after an emoji, skin tone or U+FE0F,
 *  before an emoji) — the only joiner a message body may carry. */
const EMOJI_ZWJ =
  /(?<=[\p{Extended_Pictographic}\p{Emoji_Modifier}\ufe0f])\u200d(?=\p{Extended_Pictographic})/gu;

/**
 * A message body as it will be sent — or null when it carries anything a
 * person reading the preview could not see (UNSAFE_TEXT_RE). Normalised, so
 * the stored, shown and sent bodies are identical: CRLF / CR become LF,
 * every space separator a plain space, trailing spaces go from every line (a line of only spaces becomes empty),
 * and the whole is trimmed. Line breaks are the only exception to the
 * refusal, plus a ZWJ inside an emoji sequence: a ZWNJ / ZWJ between letters
 * could sit inside a link ("ba<ZWNJ>nk.co.za") and change where it goes
 * while looking the same. Interior runs of spaces stay (pre-wrap shows
 * them). Refusing, not stripping, so the recipient never gets a character
 * the approver didn't see.
 */
export function messageBody(value: string): string | null {
  const body = plainSpaces(value)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/ +$/, ""))
    .join("\n")
    .trim();
  return UNSAFE_TEXT_RE.test(body.replace(/\n/g, " ").replace(EMOJI_ZWJ, "").replace(EMOJI_PRESENTATION, "")) ? null : body;
}

/**
 * Characters that pass for a Latin letter, mapped to it: a curated subset of
 * Unicode UTS #39 confusables (Cyrillic, Greek, Armenian, Cherokee), NOT
 * complete. CAPITAL_CONFUSABLES are capitals whose lowercase no longer looks
 * Latin (Cyrillic \u0422, Greek \u0397), mapped before lowercasing; the rest
 * are keyed by their lowercase form, so either case is caught (\u051c, \u054d).
 */
const CAPITAL_CONFUSABLES = new Map<string, string>([
  ["\u0412", "b"], ["\u041a", "k"], ["\u041c", "m"], ["\u041d", "h"], ["\u0422", "t"], ["\u0392", "b"],
  ["\u0397", "h"], ["\u0399", "l"], ["\u039a", "k"], ["\u039c", "m"], ["\u039d", "n"], ["\u03a4", "t"],
  ["\u03a5", "y"], ["\u03a7", "x"], ["\u0396", "z"], ["\u0391", "a"], ["\u0395", "e"],
]);
const LOWER_CONFUSABLES = new Map<string, string>([
  ["\u0430", "a"], ["\u0435", "e"], ["\u043e", "o"], ["\u0440", "p"], ["\u0441", "c"], ["\u0443", "y"],
  ["\u0445", "x"], ["\u0455", "s"], ["\u0456", "l"], ["\u0458", "j"], ["\u04bb", "h"], ["\u04af", "y"],
  ["\u0501", "d"], ["\u051b", "q"], ["\u051d", "w"], ["\u03bf", "o"],
  ["\u03c1", "p"], ["\u03bd", "v"], ["\u0585", "o"], ["\u057d", "u"], ["\u0570", "h"], ["\u0578", "n"],
  ["\u0566", "q"], ["\u0581", "g"], ["\uab7a", "a"], ["\u13fc", "b"], ["\uabaf", "c"], ["\uab70", "d"],
  ["\uab7c", "e"], ["\uab90", "g"], ["\uab8b", "h"], ["\uab7b", "j"], ["\uabb6", "k"], ["\uabae", "l"],
  ["\uab87", "m"], ["\uabb2", "p"], ["\uab71", "r"], ["\uabaa", "s"], ["\uab72", "t"], ["\uaba9", "v"],
  ["\uab83", "w"], ["\uab93", "z"],
  // Symbols that pass for a letter, for duplicates only (they never make a word look-alike).
  ["\u00d7", "x"], ["\u25e6", "o"], ["\u25cb", "o"], ["\u25ef", "o"], ["\u26ac", "o"], ["\u237a", "a"],
  ["\u2373", "i"], ["\u2374", "p"], ["\u2375", "w"],
]);

/** Spaces, connectors, brackets and quote marks never tell two names apart
 *  ("Don\u2019t" = "Don't", "(Pro)" = "Pro"), nor does a dash joining two
 *  letters ("Follow-up" = "Follow up"); symbols, other punctuation and other
 *  dashes do ("A+" / "A", "A-" / "A", "1-2" / "12",
 *  "10.0" / "100", emoji). */
const SEPARATORS = /[\s\p{Pc}\p{Ps}\p{Pe}'"`\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f\u2032\u2033\u02bc\uff07]/gu;
// Every dash (and minus) is "-" first, so "Plan\u20102" = "Plan-2" wherever it stands.
const dropSeparators = (value: string) =>
  value.replace(/[\p{Pd}\u2212\ufe63\uff0d\u2043\u02d7]/gu, "-").replace(/(?<=[\p{L}\p{M}])-+(?=\p{L})/gu, "").replace(SEPARATORS, "");

/** A name folded for "is this the same name?": NFKC, case-folded, separators
 *  dropped. */
function casefoldKey(value: string): string {
  return dropSeparators(value.normalize("NFKC").toLowerCase());
}

/** Vertical bars that pass for an l (\u2223 \u05c0 \u2502 \u23d0 \ufe31 \u01c0 | \uff5c),
 *  mapped before NFKC can turn them into dashes; the double bar \u01c1 reads as ll. */
const BAR_LIKE = /[\u2223\u05c0\u2502\u23d0\ufe31\u01c0|\uff5c]/g;
const IS_BAR = /[\u2223\u05c0\u2502\u23d0\ufe31\u01c0\u01c1|\uff5c]/u;

/**
 * What a name looks like (UTS #39 style): bar-like symbols read as l; NFKC;
 * capital I and the capital confusables mapped; case-folded, then NFC (so
 * "\u0130" keeps its dot); the lowercase confusables mapped; separators
 * dropped; 1 read as l, 0 as o. "rn" / "vv" also read as "m" /
 * "w": deliberately, as a spoof is worse than refusing the odd real pair
 * (Modern / Modem).
 */
export function skeleton(value: string): string {
  const capitals = [...value.replace(/\u01c1/g, "ll").replace(BAR_LIKE, "l").normalize("NFKC")].map((c) => (c === "I" ? "l" : (CAPITAL_CONFUSABLES.get(c) ?? c))).join("");
  // Separators go before 1 / 0 become letters, so "0800-123" keeps its dash.
  return dropSeparators([...capitals.toLowerCase().normalize("NFC")].map((c) => LOWER_CONFUSABLES.get(c) ?? c).join(""))
    .replace(/1/g, "l")
    .replace(/0/g, "o")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w");
}

const ASCII = /^[\x00-\x7f]*$/;

/** A run of letters / digits mixing Latin with Cyrillic or Greek:
 *  "B\u0430nk" (a Cyrillic a) reads as "Bank". A run wholly in one script is
 *  fine, and so are scripts joined by punctuation ("\u00b5-controller"; a
 *  Greek prefix like "\u0394-value" is accepted the same way). */
const MIXED_SCRIPT_WORD = /(?=[\p{L}\p{M}\p{N}]*\p{Script=Latin})(?=[\p{L}\p{M}\p{N}]*[\p{Script=Cyrillic}\p{Script=Greek}])[\p{L}\p{M}\p{N}]+/u;

/** Latin letters beyond ASCII (and a base letter with accents) that are
 *  letters in their own right, not look-alikes: \u00df \u00e6 \u00f8 \u0153 \u00f0 \u00fe \u0142 \u0111. */
const PLAIN_LATIN_EXTRA = new Set([
  "\u00df", "\u00e6", "\u00c6", "\u00f8", "\u00d8", "\u0153", "\u0152", "\u00f0",
  "\u00d0", "\u00fe", "\u00de", "\u0142", "\u0141", "\u0111", "\u0110",
  // Khoisan clicks: \u01c2 imitates nothing, and \u01c1 is read as "ll" in the skeleton.
  // \u01c0 (reads as l) and \u01c3 (reads as "!") are not here, so both are refused.
  "\u01c1", "\u01c2",
]);

/**
 * A letter that imitates a plain Latin one: any Latin-script letter that
 * isn't ASCII, an ASCII letter with combining marks (\u00e9, \u1ec5, \u00e7)
 * or one of PLAIN_LATIN_EXTRA (IPA, small capitals, script g, dotless i,
 * Latin alpha, and so on), and any Lisu letter. An allowlist, so the class is
 * closed without listing every look-alike.
 */
function imitatesLatin(ch: string): boolean {
  if (/\p{Script=Lisu}/u.test(ch)) return true;
  if (!/\p{Script=Latin}/u.test(ch) || ch.charCodeAt(0) < 0x80 || PLAIN_LATIN_EXTRA.has(ch)) return false;
  return !/^[A-Za-z]\p{M}+$/u.test(ch.normalize("NFD"));
}

const IS_SEPARATOR = new RegExp(SEPARATORS.source, "u");

/**
 * A symbol touching an ASCII letter in the same word (\u212e \u0966 \u0665 \u2229 in
 * "Bank d\u212etails", "Invoic\u212e", "B\u0966nus"). Between two letters only ASCII
 * digits, marks, Latin letters, separators and . & / + : , belong ("@" does not,
 * so an email address is refused as a name) (a Latin letter
 * that imitates another is refused before this runs). At the start or end of
 * a word only what passes for a letter is refused: a letterlike symbol NFKC
 * doesn't spell in ASCII (\u212e), a non-ASCII decimal digit (\u0966), a
 * mathematical operator (\u2229), and a letter outside Latin, Greek and
 * Cyrillic (Coptic \u2c9f, Tifinagh \u2d4f), which the other checks cover.
 * Any other symbol is fine there (\u00ae \u00b0 \u00ab \u00d7).
 */
function symbolInWord(value: string): boolean {
  const text = value.normalize("NFC");
  const asciiLetter = (c: string | undefined) => !!c && /[A-Za-z]/.test(c);
  const odd = (c: string) => !/[0-9.&/+:,\p{M}\p{Pd}]/u.test(c) && !IS_SEPARATOR.test(c) && !/\p{Script=Latin}/u.test(c);
  const oddAtEdge = (c: string) => {
    const cp = c.codePointAt(0) ?? 0;
    if (/\p{L}/u.test(c)) return !/[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u.test(c.normalize("NFKC"));
    if (/\p{Nd}/u.test(c)) return !/[0-9]/.test(c);
    if (cp >= 0x2100 && cp <= 0x214f) return !/^[\x21-\x7e]+$/.test(c.normalize("NFKC"));
    return cp >= 0x2200 && cp <= 0x22ff;
  };
  for (const m of text.matchAll(/[^A-Za-z\s]+/gu)) {
    const [before, after] = [asciiLetter(text[m.index - 1]), asciiLetter(text[m.index + m[0].length])];
    if (before && after ? [...m[0]].some(odd) : (before || after) && [...m[0]].some(oddAtEdge)) return true;
  }
  return false;
}

/**
 * A combining mark left after NFC on a bare Latin letter, a digit or a bar: a
 * standard accented letter (\u00e9, \u1ec5) composes, so a leftover mark there
 * is a decoration that can make one character pass for another (i + \u0307,
 * 1 + \u0307). A mark stacked on an already-accented letter is fine (Yoruba
 * \u1ecd + \u0301), and so are marks on other scripts (Devanagari, Thai, ...).
 */
function latinMarkLeft(value: string): boolean {
  let base = "";
  for (const c of value.normalize("NFC")) {
    // Emoji presentation, and the keycap on 0-9 # * ("5\ufe0f\u20e3"), are not decorations on a letter.
    if (c === "\ufe0f" || (c === "\u20e3" && /^[0-9#*]$/.test(base))) continue;
    if (!/\p{M}/u.test(c)) base = c;
    else if (/\p{N}/u.test(base) || IS_BAR.test(base) || (/\p{Script=Latin}/u.test(base) && !/\p{M}/u.test(base.normalize("NFD")))) return true;
  }
  return false;
}

/**
 * Why an agent-chosen name could pass for another, or null: a letter that
 * imitates a plain Latin one, a run mixing scripts, a word written wholly in
 * Latin look-alikes, or the same skeleton
 * as one of `existing` (same scope). For names a person picks from a list (snippets, field labels,
 * options, folders).
 */
export function lookAlikeProblem(value: string, existing: readonly string[]): string | null {
  if (latinMarkLeft(value)) return "has a mark that can't combine into a standard accented letter";
  // Letters only: symbols NFKC turns into ASCII (\u2122 \u00b2 \u2026 \u2163) never count.
  const letters = (w: string) => [...w].filter((c) => /\p{L}/u.test(c)).join("");
  if ([...letters(value)].some(imitatesLatin)) return "uses a letter that imitates a plain Latin letter";
  if (MIXED_SCRIPT_WORD.test(value)) return "mixes Latin with Cyrillic or Greek letters in one word";
  // A word made only of letters that pass for Latin ones reads as Latin.
  // Each run of letters alone ("\u03b1-test": "\u03b1" and "test"; "B.\u0430.nk": "\u0430").
  if (value.split(/[^\p{L}\p{M}]+/u).map(letters).some((w) => w && !ASCII.test(w) && ASCII.test(skeleton(w)))) {
    return "uses letters from another script that look like Latin ones";
  }
  // A name of separators only has an empty key, which matches nothing.
  const [key, folded] = [skeleton(value), casefoldKey(value)];
  if (existing.some((e) => (key && skeleton(e) === key) || (folded && casefoldKey(e) === folded))) return "is the same as, or looks like, an existing one";
  if (symbolInWord(value)) return "has a symbol inside a word that can pass for a letter";
  return null;
}
