/**
 * Text an approver or an agent reads, kept honest: which characters a stored
 * value may not carry, how agent input is normalised before that check, and
 * how stored values print on one line.
 */

/** Control (Cc, incl. NEL), format (Cf: zero-width, bidi marks, BOM) and
 *  line / paragraph separator characters, plus the characters that render
 *  as nothing without being Cf: the combining grapheme joiner (U+034F), the
 *  Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) and the blank braille
 *  cell (U+2800). Refused in stored text an approver reads (a newline could
 *  fake a preview row, an invisible one hide text). U+FE0F (emoji
 *  presentation) is a variation selector, not in the set. */
export const UNSAFE_TEXT_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034f\u115f\u1160\u2800\u3164\uffa0]/u;

/** A ZWNJ / ZWJ that joins two letters, marks or emoji — Persian names,
 *  family emoji sequences (U+1F468 U+200D U+1F469 …) — is text, not a trick. */
const JOINER_IN_WORD =
  /(?<=[\p{L}\p{M}\p{Extended_Pictographic}])[\u200c\u200d](?=[\p{L}\p{M}\p{Extended_Pictographic}])/gu;

/** UNSAFE_TEXT_RE, except a ZWNJ / ZWJ between letters, marks or emoji. */
export function hasUnsafeText(value: string): boolean {
  return UNSAFE_TEXT_RE.test(value.replace(JOINER_IN_WORD, ""));
}

/**
 * An agent-supplied field, trimmed. For `address` only, line breaks are
 * folded to ", " first — people store multi-line addresses (the forms use a
 * textarea) — so the unsafe-text check that follows still refuses every
 * other control character, and a newline in any other field.
 */
export function agentText(key: string, value: string): string {
  const v = value.trim();
  return key === "address" ? v.replace(/\s*[\r\n]+\s*/g, ", ") : v;
}

/** A stored value on one line, for list output (legacy data may hold newlines). */
export function oneLine(value: unknown): string {
  return String(value ?? "").replace(/[\s\u0085\u2028\u2029]+/g, " ").trim();
}
