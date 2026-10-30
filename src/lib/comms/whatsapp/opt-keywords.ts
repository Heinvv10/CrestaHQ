/**
 * Opt-out / opt-in keywords, matched against the WHOLE inbound message — one
 * rule for every WhatsApp inbound route, the SMS route, and the template
 * builder (a quick-reply button's text arrives as the message body, so a
 * button labelled with a stop keyword would opt out whoever taps it).
 *
 * Whole-message, not first-word: a bare "Cancel" opts out (the carrier
 * keyword set), but "Cancel my installation tomorrow" is a customer talking,
 * and "Yes I'll be there" is not an opt-in.
 */
export const WHATSAPP_STOP_WORDS = new Set([
  "STOP",
  "STOPALL",
  "STOP ALL",
  "UNSUBSCRIBE",
  "OPT OUT",
  "CANCEL",
  "END",
  "QUIT",
]);
export const WHATSAPP_START_WORDS = new Set(["START", "UNSTOP"]);

/** The message as the keyword sets see it: trimmed, uppercased, surrounding
 *  punctuation/emoji stripped, internal whitespace collapsed to one space. */
export function optKeyword(text: string): string {
  return text
    .toUpperCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .replace(/\s+/g, " ");
}
