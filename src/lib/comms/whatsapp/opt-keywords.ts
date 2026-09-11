/**
 * WhatsApp opt-out / opt-in keywords, read from the FIRST word of an inbound
 * message (uppercased). One list for every WhatsApp inbound route, and for the
 * template builder: a quick-reply button's text arrives as the message body,
 * so a button labelled with a stop word would opt out whoever taps it.
 */
export const WHATSAPP_STOP_WORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);
export const WHATSAPP_START_WORDS = new Set(["START", "UNSTOP", "YES"]);

/** The keyword the routes read: the message's first word, uppercased. */
export function firstKeyword(text: string): string {
  return text.trim().toUpperCase().split(/\s+/)[0] ?? "";
}
