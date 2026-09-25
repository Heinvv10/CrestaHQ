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
 *  points, which won't render, and any space but a plain U+0020 (NBSP, the
 *  U+2000 block, U+3000…), which a reader can't tell from one. Refused in
 *  stored text an approver reads (a newline could fake a preview row, an
 *  invisible one hide text or carry data). U+FE0F is default-ignorable too:
 *  only a real presentation selector (EMOJI_PRESENTATION) is let through. */
export const UNSAFE_TEXT_RE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cn}\p{Cs}\u2800]|(?! )\p{Zs}/u;
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
  const v = value.trim();
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
 * trailing spaces go from every line (a line of only spaces becomes empty),
 * and the whole is trimmed. Line breaks are the only exception to the
 * refusal, plus a ZWJ inside an emoji sequence: a ZWNJ / ZWJ between letters
 * could sit inside a link ("ba<ZWNJ>nk.co.za") and change where it goes
 * while looking the same. Interior runs of spaces stay (pre-wrap shows
 * them). Refusing, not stripping, so the recipient never gets a character
 * the approver didn't see.
 */
export function messageBody(value: string): string | null {
  const body = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/ +$/, ""))
    .join("\n")
    .trim();
  return UNSAFE_TEXT_RE.test(body.replace(/\n/g, " ").replace(EMOJI_ZWJ, "").replace(EMOJI_PRESENTATION, "")) ? null : body;
}
