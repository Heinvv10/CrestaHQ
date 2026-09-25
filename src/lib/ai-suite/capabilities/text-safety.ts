/**
 * Text an approver or an agent reads, kept honest: which characters a stored
 * value may not carry, how agent input is normalised before that check, and
 * how stored values print on one line.
 */

/** Control (Cc, incl. NEL), format (Cf: zero-width, bidi marks, BOM) and
 *  line / paragraph separator characters, plus the characters that render
 *  as nothing without being Cf: the combining grapheme joiner (U+034F), the
 *  Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) and the blank braille
 *  cell (U+2800), the Khmer inherent vowels (U+17B4, U+17B5), the Mongolian
 *  free variation selectors (U+180B–U+180D, U+180F) and the variation
 *  selectors U+FE00–U+FE0E and U+E0100–U+E01EF. Refused in stored text an
 *  approver reads (a newline could fake a preview row, an invisible one hide
 *  text). U+FE0F (emoji presentation) stays allowed. */
const INVISIBLE_LETTERS =
  "\\u034f\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180d\\u180f\\u2800\\u3164\\ufe00-\\ufe0e\\uffa0\\u{e0100}-\\u{e01ef}";
export const UNSAFE_TEXT_RE = new RegExp(`[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}${INVISIBLE_LETTERS}]`, "u");
/** What oneLine removes outright: format characters and the same invisible letters. */
const STRIP_RE = new RegExp(`[\\p{Cf}${INVISIBLE_LETTERS}]`, "gu");

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

/** A stored value on one line, for list output and previews (legacy or
 *  externally supplied data — a WhatsApp profile name, a web-chat visitor —
 *  may hold separators, control, zero-width or bidi characters). */
export function oneLine(value: unknown): string {
  return String(value ?? "").replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(STRIP_RE, "").trim();
}

/** A ZWJ inside an emoji sequence (after an emoji, skin tone or U+FE0F,
 *  before an emoji) — the only joiner a message body may carry. */
const EMOJI_ZWJ =
  /(?<=[\p{Extended_Pictographic}\p{Emoji_Modifier}\ufe0f])\u200d(?=\p{Extended_Pictographic})/gu;

/**
 * A message body as it will be sent: CRLF / CR normalised to LF, trimmed —
 * or null when it carries anything a person reading the preview could not
 * see (control, format, separator or invisible characters). Line breaks are
 * the only exception, plus a ZWJ inside an emoji sequence: a ZWNJ / ZWJ
 * between letters could sit inside a link ("ba<ZWNJ>nk.co.za") and change
 * where it goes while looking the same. Refusing, not stripping, so the
 * recipient never gets a character the approver didn't see.
 */
export function messageBody(value: string): string | null {
  const body = value.replace(/\r\n?/g, "\n").trim();
  return UNSAFE_TEXT_RE.test(body.replace(/\n/g, " ").replace(EMOJI_ZWJ, "")) ? null : body;
}
