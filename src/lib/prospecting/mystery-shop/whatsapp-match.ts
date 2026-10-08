/**
 * A WhatsApp message in reply to a mystery shop → does it count, and is it
 * automatic? Pure.
 *
 * WhatsApp Business greeting and away messages are sent by the app the moment
 * a message arrives, and Meta does not flag them. So a reply is automatic
 * (`autoReplyAt`; the shop keeps waiting) when:
 *   - it came within INSTANT_REPLY_MS of the send, whatever it says — no person
 *     reads and answers an enquiry that fast; or
 *   - it is short (≤ SHORT_REPLY_MAX characters) and greeting / away /
 *     office-hours phrasing (en, af, zu) is most of it: the phrases' letters at
 *     least equal the rest's. "Thank you for contacting Acme Plumbing!" is
 *     automatic; "Thank you for your message! Yes we do plumbing in Gqeberha,
 *     today 2pm?" is a person.
 * A person mistaken for a machine leaves the shop waiting, so it ends as an
 * unconfirmed miss a member checks — never as an automatic public "responded".
 */

export const INSTANT_REPLY_MS = 60_000;
export const SHORT_REPLY_MAX = 280;

const AUTO_REPLY = new RegExp(
  [
    "(?:i(?:'|’)?m|i am|we(?:'|’)?re|we are) (?:currently )?away(?: from (?:the|my|our) (?:office|desk|phone))?",
    "away from (?:the|my|our) (?:office|desk|phone)",
    "thank(?:s| you) for (?:contacting|your message|reaching out|getting in touch|your (?:enquiry|inquiry)|messaging)",
    "we(?: will|(?:'|’)ll) get back to you",
    "we will respond as soon as",
    "outside (?:of )?(?:our )?(?:business|office|working) hours",
    "our (?:business|office|working) hours",
    "currently (?:unavailable|closed)",
    "welcome to",
    "reply \\d+ for",
    "dankie vir (?:u|jou) boodskap",
    "ons sal (?:u |jou )?so gou (?:as )?moontlik",
    "siyabonga ngokusithinta",
  ].join("|"),
  "gi",
);

const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").length;

export function isWhatsAppAutoReply(text: string, elapsedMs: number): boolean {
  if (elapsedMs < INSTANT_REPLY_MS) return true;
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || t.length > SHORT_REPLY_MAX) return false;
  const phrase = [...t.matchAll(AUTO_REPLY)].reduce((n, m) => n + letters(m[0]), 0);
  return phrase > 0 && phrase * 2 >= letters(t);
}

/** Meta message types a person sends. Reactions, system notices, unsupported and ephemeral messages are not replies. */
const CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text", "button", "interactive", "image", "video", "audio", "document", "sticker", "location", "contacts",
]);

/** Is this inbound something the business said? A text needs words; a file, a tap or a pin counts as it is. */
export function isContentMessage(type: string, text: string): boolean {
  if (!CONTENT_TYPES.has(type)) return false;
  return type !== "text" || text.trim() !== "";
}
