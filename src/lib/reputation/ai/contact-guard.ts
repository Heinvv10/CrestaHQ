/**
 * The AI draft's contact guard (SP5 c) — a BEST-EFFORT filter. It catches the
 * common ways of writing a phone number, email, link, domain, USSD code,
 * social handle or social platform the business's reply guidelines did not
 * supply, and refuses the draft (it is never shown). A determined review can
 * still slip a contact past it — a regex cannot out-think a language model —
 * so the control is the admin, who reads every draft and must click "Post
 * reply to Google". Anything written in the guidelines is allowed, even inside
 * "never mention …".
 *
 * Both texts go through the SAME normalisation and extractors; allowed
 * contacts match as exact tokens, never substrings:
 *   - NFKC, format characters (\p{Cf}) removed, look-alike stops (。｡．·・•…)
 *     → ".", any-script digits read as their value, lower case;
 *   - obfuscations undone: "[.]", "(dot)", "<dot>", "-dot-", "_dot_", " dot ",
 *     "evil .com", "evil . com", "evil. com" (lower-case next word, not after
 *     an abbreviation), "evil,com"; "[at]", "(at)", "<at>" → "@";
 *   - domain: `label.label…` whose last label is 2+ letters (any script, so
 *     IDNs) or punycode (`xn--…`); "e.g.", "a.m.", "1.5" are not domains;
 *   - phone: 7+ digits within 25 characters (number words "oh".."nine" read as
 *     digits), AFTER masking dates, times, prices, years, thousands, units and
 *     order / ref / ticket / invoice numbers; +27 and a leading 0 are the same
 *     number; two numbers in the guidelines split at "/", " or ", ",", ";" or
 *     a line break;
 *   - USSD (`*120*555#`, spaced too); `@handle` not part of an email;
 *     platforms (Instagram/IG, Facebook, TikTok, WhatsApp, Telegram, Signal,
 *     Threads, Discord, X/Twitter, Snapchat, LinkedIn, YouTube).
 * Known false positives are accepted because they fail safe (the draft is
 * refused, the admin writes their own): "Mr.Smith", "review.We",
 * "@everyone", a lower-case word after a full stop, "we'll signal the team".
 * Pure — no I/O.
 */

export type ContactKind = "url" | "email" | "domain" | "phone" | "ussd" | "handle" | "platform";

const L = "\\p{L}\\p{M}";
const LN = `${L}\\p{N}`;
const LAST = `(?:(?:\\p{L}\\p{M}*){2,}|xn--[a-z0-9-]+)`;
const DOMAIN_RE = new RegExp(`(?<![${LN}-])(?:[${LN}](?:[${LN}-]*[${LN}])?\\.)+${LAST}(?![${LN}-])`, "gu");
const EMAIL_RE = new RegExp(`[${LN}._%+-]+@(?:[${LN}](?:[${LN}-]*[${LN}])?\\.)+${LAST}`, "gu");
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s/?#]+/gu;
const HANDLE_RE = new RegExp(`(?<![${LN}._%+-])@([${LN}_]+(?:\\.[${LN}_]+)*)`, "gu");
const USSD_RE = /\*\s*\d+(?:\s*\*\s*\d+)*\s*\*?\s*#/g;
const PLATFORM_RE =
  /\b(instagram|insta|ig|facebook|fb|tik\s?tok|whats\s?app|telegram|signal|threads|discord|twitter|snapchat|linkedin|youtube)\b/g;
const LOOKALIKE_DOTS = /[。｡．·⸱‧•・⸼۔։܁।።׃]/g;
const ABBREVIATIONS = new Set(["etc", "vs", "approx", "no", "nr", "mr", "mrs", "ms", "dr", "st", "ave", "rd", "tel", "ph", "incl", "excl"]);
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

/** The value of any Unicode decimal digit: digit blocks are runs of ten starting at zero. */
function digitValue(ch: string): string {
  const cp = ch.codePointAt(0)!;
  let start = cp;
  while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
  return String((cp - start) % 10);
}

export function normaliseForContacts(text: string): string {
  let t = text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(LOOKALIKE_DOTS, ".")
    .replace(/\p{Nd}/gu, (d) => (/[0-9]/.test(d) ? d : digitValue(d)));
  // Case still tells "evil. com" (join) from "sorry. We" (a sentence).
  t = t
    .replace(new RegExp(`([${LN}])\\s+\\.\\s*(?=[${L}]{2,})`, "gu"), "$1.")
    .replace(new RegExp(`([${LN}]{2,})\\.\\s+(?=\\p{Ll}{2,})`, "gu"), (m, w: string) => (ABBREVIATIONS.has(w.toLowerCase()) ? m : `${w}.`))
    .replace(/(\p{L}),(\p{L})/gu, "$1.$2");
  return t
    .toLowerCase()
    .replace(/\s*[[({<]\s*(?:dot|\.)\s*[\])}>]\s*/g, ".")
    .replace(/\s*[[({<]\s*at\s*[\])}>]\s*/g, "@")
    .replace(/[-_]dot[-_]/g, ".")
    .replace(new RegExp(`([${LN}])\\s+dot\\s+(?=[${L}]{2,})`, "gu"), "$1.");
}

/**
 * Digits in dates, times, prices, years, big numbers, units and order/ref
 * numbers — none of them a phone. A year or a thousands group next to other
 * digits is left alone: it may be part of a number.
 */
function maskNonPhones(t: string): string {
  const x = (m: string) => m.replace(/\d/g, "x");
  return t
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, x)
    .replace(/\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b/g, x)
    .replace(/\b\d{1,2}[:h]\d{2}(?:\s?[ap]\.?m\.?)?/g, x)
    .replace(/\br\s?\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{2})?\b/g, x)
    .replace(/\b(?:order|ref(?:erence)?|ticket|invoice|inv|account|acc|case)\b\s*(?:no\.?|number|#)?\s*[:#]?\s*[a-z]*[-\d][\w-]*/g, x)
    .replace(/#\s?\d[\d-]*/g, x)
    .replace(/(?<!\d[ ./-]?)\b(?:19|20)\d{2}\b(?![ ./-]?\d)/g, x)
    .replace(/(?<!\d[ ./-]?)\b[1-9]\d{0,2}(?:[ ,]\d{3})+(?![ ,-]?\d)/g, x)
    .replace(/\b\d+(?:[.,]\d+)?\s?(?:mbps|gbps|kbps|mb|gb|km|%|homes|customers|years|yrs|hours|hrs|minutes|mins|days|weeks|months)\b/g, x);
}

/** A South African number written +27… / 0027… is the same number as 0…. */
const canonicalPhone = (d: string) => (/^27\d{9}$/.test(d) ? `0${d.slice(2)}` : /^0027\d{9}$/.test(d) ? `0${d.slice(4)}` : d);

/** Every run of 7+ digits within 25 characters, as the digit clusters it spans. */
function phones(t: string, guidelines: boolean): Set<string> {
  let s = t.replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => NUMBER_WORDS[w]);
  // Guidelines may list several numbers: never let two run together.
  if (guidelines) s = s.replace(/\s+or\s+|[/,;\n]/g, " ".repeat(30));
  s = maskNonPhones(s);
  const digits = [...s.matchAll(/\d/g)].map((m) => ({ at: m.index!, d: m[0] }));
  const clusters: Array<{ from: number; to: number }> = [];
  digits.forEach((x, i) => {
    const last = clusters[clusters.length - 1];
    if (last && x.at - digits[i - 1].at <= 6) last.to = i;
    else clusters.push({ from: i, to: i });
  });
  const clusterOf = (i: number) => clusters.find((c) => i >= c.from && i <= c.to)!;
  const out = new Set<string>();
  for (let i = 0; i + 6 < digits.length; i++) {
    if (digits[i + 6].at - digits[i].at >= 25) continue;
    const a = clusterOf(i);
    const b = clusterOf(i + 6);
    out.add(canonicalPhone(digits.slice(a.from, b.to + 1).map((x) => x.d).join("")));
  }
  return out;
}

const trimPunct = (s: string) => s.replace(/[.,;:!?)\]}>'"_-]+$/, "");

interface Contacts {
  url: Set<string>;
  email: Set<string>;
  domain: Set<string>;
  phone: Set<string>;
  ussd: Set<string>;
  handle: Set<string>;
  platform: Set<string>;
}

function extract(raw: string, guidelines: boolean): Contacts {
  const t = normaliseForContacts(raw);
  const platform = (p: string) => {
    const q = p.replace(/\s/g, "");
    return q === "insta" || q === "ig" ? "instagram" : q === "fb" ? "facebook" : q;
  };
  return {
    url: new Set([...t.matchAll(URL_RE)].map((m) => trimPunct(m[0].replace(/^https?:\/\//, "").replace(/^www\./, "")))),
    email: new Set([...t.matchAll(EMAIL_RE)].map((m) => trimPunct(m[0]))),
    domain: new Set([...t.matchAll(DOMAIN_RE)].map((m) => trimPunct(m[0].replace(/^www\./, "")))),
    phone: phones(t, guidelines),
    ussd: new Set((t.match(USSD_RE) ?? []).map((u) => u.replace(/\s/g, "").replace("*#", "#"))),
    handle: new Set([...t.matchAll(HANDLE_RE)].map((m) => trimPunct(m[1]))),
    platform: new Set((t.replace(/_/g, "").match(PLATFORM_RE) ?? []).map(platform)),
  };
}

/** The first kind of contact in `text` that `guidelines` did not supply, or null. */
export function unsuppliedContact(text: string, guidelines: string | null): ContactKind | null {
  const found = extract(text, false);
  const allowed = extract(guidelines ?? "", true);
  // A URL's host must be a supplied domain; its path is then the business's own.
  for (const host of found.url) if (!allowed.domain.has(host) && !allowed.url.has(host)) return "url";
  const order: Array<Exclude<ContactKind, "url">> = ["email", "domain", "phone", "ussd", "handle", "platform"];
  for (const kind of order) {
    for (const token of found[kind]) if (!allowed[kind].has(token)) return kind;
  }
  return null;
}
