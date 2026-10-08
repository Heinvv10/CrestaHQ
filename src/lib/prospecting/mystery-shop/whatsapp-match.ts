/**
 * A WhatsApp reply to a mystery shop → automatic or a person. Pure.
 *
 * WhatsApp Business greeting and away messages are sent by the app and Meta
 * does not flag them, so the text decides: clear greeting / away / office-hours
 * phrasing (en, af) is an automatic acknowledgement (`autoReplyAt`, the shop
 * keeps waiting). Some of it is also what a person might type ("we'll get back
 * to you"): reading that as automatic leaves the shop waiting, so a reply
 * mistaken for a machine ends as an unconfirmed miss a member checks — never
 * as an automatic public "responded".
 */

const AUTO_REPLY = new RegExp(
  [
    "thank(?:s| you) for (?:contacting|your message)",
    "we(?: will|(?:'|’)ll) get back to you",
    "our business hours",
    "currently (?:unavailable|closed)",
    "\\baway\\b",
    "outside (?:of )?(?:our )?(?:business|office|working) hours",
    "dankie vir u boodskap",
    "ons sal so gou (?:as )?moontlik",
  ].join("|"),
  "i",
);

export function isWhatsAppAutoReply(text: string): boolean {
  return AUTO_REPLY.test(text.replace(/\s+/g, " "));
}
