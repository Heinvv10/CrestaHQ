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
 * Characters that look like a Latin letter, mapped to it: a curated subset
 * of Unicode UTS #39 confusables: the Cyrillic, Greek, Armenian and
 * Cherokee letters that pass for Latin ones (ASCII look-alikes are folded
 * in skeleton). Not complete: enough to stop the common impersonations.
 */
const CONFUSABLES = new Map<string, string>([
  ["\u0410", "a"], ["\u0412", "b"], ["\u0415", "e"],
  ["\u041a", "k"], ["\u041c", "m"], ["\u041d", "h"], ["\u041e", "o"], ["\u0420", "p"], ["\u0421", "c"],
  ["\u0422", "t"], ["\u0425", "x"], ["\u0423", "y"], ["\u0405", "s"], ["\u0406", "l"], ["\u0408", "j"],
  ["\u04ae", "y"], ["\u04ba", "h"], ["\u0430", "a"], ["\u0435", "e"], ["\u043e", "o"], ["\u0440", "p"],
  ["\u0441", "c"], ["\u0443", "y"], ["\u0445", "x"], ["\u0455", "s"], ["\u0456", "i"], ["\u0458", "j"],
  ["\u0501", "d"], ["\u051b", "q"], ["\u051d", "w"], ["\u04bb", "h"], ["\u04af", "y"], ["\u0391", "a"],
  ["\u0392", "b"], ["\u0395", "e"], ["\u0396", "z"], ["\u0397", "h"], ["\u0399", "l"], ["\u039a", "k"],
  ["\u039c", "m"], ["\u039d", "n"], ["\u039f", "o"], ["\u03a1", "p"], ["\u03a4", "t"], ["\u03a5", "y"],
  ["\u03a7", "x"], ["\u03bf", "o"], ["\u03c1", "p"], ["\u03bd", "v"], ["\u03b9", "i"], ["\u0555", "o"],
  ["\u0585", "o"], ["\u057d", "u"], ["\u0570", "h"], ["\u0578", "n"], ["\u0566", "q"], ["\u0581", "g"],
  ["\u13aa", "a"], ["\u13f4", "b"], ["\u13df", "c"], ["\u13a0", "d"], ["\u13ac", "e"], ["\u13c0", "g"],
  ["\u13bb", "h"], ["\u13ab", "j"], ["\u13e6", "k"], ["\u13de", "l"], ["\u13b7", "m"], ["\u13e2", "p"],
  ["\u13a1", "r"], ["\u13da", "s"], ["\u13a2", "t"], ["\u13d9", "v"], ["\u13b3", "w"], ["\u13c3", "z"],
]);

/** What a name looks like: NFKC, confusables mapped to Latin, case-folded,
 *  i / 1 / | read as l and 0 as o, "rn" / "vv" as "m" / "w", whitespace
 *  collapsed. Two names with the
 *  same skeleton can pass for each other. */
export function skeleton(value: string): string {
  const mapped = [...value.normalize("NFKC")].map((c) => CONFUSABLES.get(c) ?? c).join("");
  // Folded first, so I / i / l / 1 / | all read alike (and 0 / o).
  return mapped
    .toLowerCase()
    .replace(/[i1|]/g, "l")
    .replace(/0/g, "o")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/\s+/g, " ")
    .trim();
}

const ASCII = /^[\x00-\x7f]*$/;

/** A run of letters / digits mixing Latin with Cyrillic or Greek:
 *  "B\u0430nk" (a Cyrillic a) reads as "Bank". A run wholly in one script is
 *  fine, and so are scripts joined by punctuation ("\u00b5-controller"; a
 *  Greek prefix like "\u0394-value" is accepted the same way). */
const MIXED_SCRIPT_WORD = /(?=[\p{L}\p{M}\p{N}]*\p{Script=Latin})(?=[\p{L}\p{M}\p{N}]*[\p{Script=Cyrillic}\p{Script=Greek}])[\p{L}\p{M}\p{N}]+/u;

/**
 * Why an agent-chosen name could pass for another, or null: a word mixing
 * scripts, a word written wholly in Latin look-alikes, or the same skeleton
 * as one of `existing` (same scope). For names a person picks from a list (snippets, field labels,
 * options, folders).
 */
export function lookAlikeProblem(value: string, existing: readonly string[]): string | null {
  if (MIXED_SCRIPT_WORD.test(value)) return "mixes Latin with Cyrillic or Greek letters in one word";
  // A word made only of letters that pass for Latin ones reads as Latin.
  if (value.split(/\s+/).some((w) => !ASCII.test(w) && ASCII.test(skeleton(w)))) {
    return "uses letters from another script that look like Latin ones";
  }
  const key = skeleton(value);
  if (existing.some((e) => skeleton(e) === key)) return "is the same as, or looks like, an existing one";
  return null;
}
