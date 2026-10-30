import { segmentInfo } from "@/lib/comms/sms-segments";

/**
 * The "Send AI text" message: the OPERATOR writes it, as a template with one
 * `{{ai}}` slot, and the AI writes only that slot — a short phrase. The
 * operator's text goes out verbatim (it is theirs, as a Send SMS body is);
 * the slot is the only untrusted part, so it is held to a tiny alphabet: an
 * address, number, handle or opt-out instruction can't be written in it.
 * Pure, no server imports: the node dialog validates templates with it too.
 */

/** Always appended: this is the first message the contact gets from the business. */
export const OPT_OUT_SUFFIX = " Reply STOP to opt out.";
export const AI_SMS_MAX_SEGMENTS = 2;
export const AI_SLOT_MAX_CHARS = 80;
export const AI_SLOT = "{{ai}}";
const PLACEHOLDERS = new Set(["{{ai}}", "{{firstName}}", "{{business}}"]);

/** Segments as the carrier bills them: UCS-2 counts UTF-16 units, not code points. */
export function exactSmsSegments(text: string): number {
  const info = segmentInfo(text);
  if (info.encoding === "GSM-7") return info.segments;
  const n = text.length;
  if (n === 0) return 0;
  return n <= 70 ? 1 : Math.ceil(n / 67);
}

/** Why the operator's template can't be used, or null. The length check is
 *  the certain part only (the fixed text alone); the send re-checks exactly. */
export function templateProblem(template: string): string | null {
  const t = template.trim();
  if (!t) return "Write the message template.";
  const slots = t.split(AI_SLOT).length - 1;
  if (slots === 0) return `The template needs one ${AI_SLOT} where the AI's line goes.`;
  if (slots > 1) return `The template can have only one ${AI_SLOT}.`;
  const unknown = (t.match(/\{\{[^}]*\}\}/g) ?? []).find((p) => !PLACEHOLDERS.has(p));
  if (unknown) return `${unknown} isn't available here; use {{firstName}}, {{business}} and ${AI_SLOT}.`;
  const fixed = t.replace(/\{\{[^}]*\}\}/g, "");
  if (exactSmsSegments(`${fixed}${OPT_OUT_SUFFIX}`) > AI_SMS_MAX_SEGMENTS) {
    return "The template is too long: with the opt-out line it must fit two text messages and leave room for the AI's line.";
  }
  return null;
}

const CURLY_APOSTROPHE = new RegExp(`[${String.fromCharCode(0x2018, 0x2019, 0x02bc)}]`, "g");

/** The model's reply as a slot candidate: NFKC, straight apostrophes, no
 *  format characters, one line, no wrapping quotes. */
export function normaliseSlot(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(CURLY_APOSTROPHE, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
}

/** Words that steer the contact somewhere (a channel, a site, an action),
 *  or spell an address out. None belongs in a personal phrase. */
const ROUTE_WORDS = new Set([
  "call", "phone", "dial", "ring", "text", "sms", "reply", "respond", "message", "msg", "dm", "inbox",
  "email", "mail", "whatsapp", "facebook", "instagram", "tiktok", "twitter", "telegram", "signal", "linkedin",
  "visit", "search", "click", "tap", "follow", "subscribe", "website", "site", "online", "link",
  "www", "http", "https", "com", "net", "org", "za", "dot", "point", "period", "dott", "dawt",
]);

/** Why `slot` can't go out, or null. Latin letters, spaces, apostrophes,
 *  hyphens and commas, with one optional . ! or ? at the end — no digits or
 *  other punctuation — so no address, number or handle fits in it. */
export function slotProblem(slot: string): string | null {
  if (!slot) return "it was empty";
  if (slot.length > AI_SLOT_MAX_CHARS) return `it was longer than ${AI_SLOT_MAX_CHARS} characters`;
  if (!/^[\p{Script=Latin}' ,-]+[.!?]?$/u.test(slot)) {
    return "it used characters other than letters, spaces, apostrophes, hyphens, commas and one final . ! or ?";
  }
  let singles = 0;
  for (const word of slot.replace(/[.!?]$/, "").split(/[\s,]+/).filter(Boolean)) {
    const letters = word.replace(/['-]/g, "");
    if (letters.length === 0) return "it had a word with no letters";
    singles = letters.length === 1 ? singles + 1 : 0;
    if (singles >= 3) return "it had three single letters in a row";
    if (/\p{Lu}/u.test(letters.slice(1))) return `"${word}" has capitals inside it`;
    if (/stop|unsubscribe|opt/i.test(letters)) return `"${word}" reads as an opt-out word`;
    if (ROUTE_WORDS.has(letters.toLowerCase())) return `"${word}" names a channel, a site or an action`;
  }
  return null;
}

/** A first name for `{{firstName}}`: letters only, 2-20 of them, or null. */
export function smsFirstName(name: string | null | undefined): string | null {
  const first = (name ?? "").normalize("NFKC").trim().split(/\s+/)[0] ?? "";
  return /^\p{L}{2,20}$/u.test(first) ? first : null;
}

/** The text that goes out: the template with the slot (or nothing), the
 *  first name ("there" when there is none) and the business filled in, then
 *  the opt-out line. */
export function assembleAiSms(input: {
  template: string;
  slot: string | null;
  firstName: string | null;
  business: string;
}): string {
  const withSlot = input.slot
    ? input.template.replace(AI_SLOT, input.slot)
    : input.template.replace(/[ \t]*\{\{ai\}\}[ \t]*/, " ");
  const body = withSlot
    .split("{{firstName}}").join(input.firstName ?? "there")
    .split("{{business}}").join(input.business)
    .trim();
  return `${body}${OPT_OUT_SUFFIX}`;
}
