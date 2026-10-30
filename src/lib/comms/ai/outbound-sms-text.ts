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
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014, 0x2212)}]`, "g");

/** Text from the model (or a contact's name) as ASCII where it can be: NFKD
 *  with the accents dropped ("stóp" is "stop"), straight apostrophes, dashes
 *  as "-", no format characters, one line, no wrapping quotes. What can't be
 *  made ASCII (small caps, other scripts, emoji) stays, and the charset check
 *  refuses it. */
export function normaliseSlot(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\p{Cf}/gu, "")
    .replace(CURLY_APOSTROPHE, "'")
    .replace(DASHES, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
}

const NUMBER_WORDS = new Set([
  "zero", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "double", "triple", "hundred", "thousand",
]);
const OPT_OUT_WORDS = new Set(["stop", "quit", "cancel", "unsubscribe", "unsub", "optout", "opt-out", "remove"]);
/** Channels and destinations. Verbs (call, text, visit…) are not here: with
 *  digits and number words refused, no destination can follow them. */
const ROUTE_WORDS = new Set([
  "whatsapp", "facebook", "instagram", "insta", "telegram", "tiktok", "twitter", "email", "e-mail", "dm", "inbox",
  "www", "http", "https", "com", "co", "za", "net", "org", "dot", "slash", "url", "link", "website",
]);

/**
 * Why `slot` can't go out, or null. The charset does the heavy lifting:
 * ASCII letters, spaces and ' , . ! ? : ) - only, so no digit, symbol,
 * accent trick or other script fits. Then: at most two sentences, ":" and
 * ")" only as ":)", no "." "!" or "?" inside a word, no three single letters
 * in a row, fewer than three number words, no opt-out word and no channel or
 * destination word. Words are whole words (split on "-" and "'" too), never
 * substrings, so "option" and "adopt" pass.
 */
export function slotProblem(slot: string): string | null {
  if (!slot) return "it was empty";
  if (slot.length > AI_SLOT_MAX_CHARS) return `it was longer than ${AI_SLOT_MAX_CHARS} characters`;
  if (!/^[A-Za-z' ,.!?:)-]+$/.test(slot)) {
    return "it used characters other than plain letters, spaces and ' , . ! ? : ) -";
  }
  const plain = slot.replace(/:\)/g, " ");
  if (/[:)]/.test(plain)) return 'it used ":" or ")" other than in ":)"';
  if (/[.!?](?=[^\s.!?])/.test(plain)) return "it had . ! or ? inside a word";
  if ((plain.match(/[.!?]+/g) ?? []).length > 2) return "it was more than two sentences";
  const tokens = plain.toLowerCase().split(/[\s,.!?]+/).filter(Boolean);
  let singles = 0;
  let numbers = 0;
  for (const token of tokens) {
    const parts = token.split(/['-]+/).filter(Boolean);
    const letters = parts.join("");
    singles = letters.length === 1 ? singles + 1 : letters.length === 0 ? singles : 0;
    if (singles >= 3) return "it had three single letters in a row";
    numbers += parts.filter((w) => NUMBER_WORDS.has(w)).length;
    if (numbers >= 3) return "it had three or more number words";
    if (OPT_OUT_WORDS.has(token) || parts.some((w) => OPT_OUT_WORDS.has(w))) return `"${token}" reads as an opt-out word`;
    if (ROUTE_WORDS.has(token) || parts.some((w) => ROUTE_WORDS.has(w))) return `"${token}" names a channel or a destination`;
  }
  if (/\bopt\s+out\b/.test(tokens.join(" "))) return '"opt out" reads as an opt-out instruction';
  return null;
}

/** A first name for `{{firstName}}`: Latin letters only after the same
 *  normalisation, 2-20 of them, and nothing the slot rules would refuse
 *  ("Stop", "Whatsapp"); otherwise null. */
export function smsFirstName(name: string | null | undefined): string | null {
  const first = normaliseSlot(name ?? "").split(/\s+/)[0] ?? "";
  if (!/^\p{Script=Latin}{2,20}$/u.test(first)) return null;
  return slotProblem(first) ? null : first;
}

/** The text that goes out: the template with the slot (or nothing), the
 *  first name ("there" when there is none) and the business filled in, then
 *  the opt-out line. One pass over the template, so nothing put in is read
 *  as a placeholder again; braces are dropped from the business name. */
export function assembleAiSms(input: {
  template: string;
  slot: string | null;
  firstName: string | null;
  business: string;
}): string {
  const values: Record<string, string> = {
    ai: input.slot ?? "",
    firstName: input.firstName ?? "there",
    business: input.business.replace(/[{}]/g, ""),
  };
  const template = input.slot ? input.template : input.template.replace(/[ \t]*\{\{ai\}\}[ \t]*/, " {{ai}}");
  const body = template.replace(/\{\{(ai|firstName|business)\}\}/g, (_, key: string) => values[key]).trim();
  return `${body}${OPT_OUT_SUFFIX}`;
}
