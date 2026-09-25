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
 *  Refused in stored text an approver reads (a newline could fake a preview
 *  row, an invisible one hide text). U+FE0F (emoji presentation) is
 *  default-ignorable too, and is let through by every check below. */
export const UNSAFE_TEXT_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/u;
/** What oneLine removes outright: the same invisible set, less U+FE0F. */
const STRIP_RE = /(?!\ufe0f)[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu;
/** Emoji presentation — the one default-ignorable character that's text. */
const EMOJI_PRESENTATION = /\ufe0f/g;

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
  return UNSAFE_TEXT_RE.test(body.replace(/\n/g, " ").replace(EMOJI_ZWJ, "").replace(EMOJI_PRESENTATION, "")) ? null : body;
}
