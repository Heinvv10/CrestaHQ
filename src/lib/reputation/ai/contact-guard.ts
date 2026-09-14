/**
 * The AI draft's contact guard (SP5 c). A draft may carry a phone number,
 * email, link, domain, USSD code, social handle or social platform ONLY if the
 * business's reply guidelines supplied that exact one. Anything else refuses
 * the draft (it is never shown) — so a prompt-injected review cannot get a
 * scam contact into a public reply through the draft.
 *
 * Both texts go through the SAME normalisation and extractors, and allowed
 * contacts are compared as exact tokens (never substrings):
 *   - NFKC (full-width digits and letters, compatibility dots), zero-width and
 *     other format characters (\p{Cf}) removed, ideographic / full-width stops
 *     → ".", lower case; every \p{Nd} digit read as its value (Arabic-Indic too);
 *   - obfuscations undone: "[.]", "(dot)", " dot ", " . " between words → ".";
 *     "[at]", "(at)" → "@";
 *   - domain: `label.label…` whose last label is ≥ 2 letters (any script, so
 *     IDNs too) — no TLD list. "e.g.", "i.e.", "a.m.", "U.S.A." (1-letter
 *     last label) and decimals ("1.5") are not domains;
 *   - phone: 7+ digits within 25 characters, whatever separates them;
 *   - USSD: `*120*555#`; handle: `@name` not part of an email; platform:
 *     Instagram, Facebook, TikTok, WhatsApp, Telegram, X/Twitter, Snapchat,
 *     LinkedIn, YouTube.
 * Pure — no I/O — so the browser could reuse it.
 */

export type ContactKind = "url" | "email" | "domain" | "phone" | "ussd" | "handle" | "platform";

const L = "\\p{L}\\p{M}";
const LN = `${L}\\p{N}`;
const DOMAIN_RE = new RegExp(`(?<![${LN}-])(?:[${LN}](?:[${LN}-]*[${LN}])?\\.)+(\\p{L}\\p{M}*){2,}(?![${LN}-])`, "gu");
const EMAIL_RE = new RegExp(`[${LN}._%+-]+@((?:[${LN}](?:[${LN}-]*[${LN}])?\\.)+[${L}]{2,})`, "gu");
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s/?#]+/gu;
const HANDLE_RE = new RegExp(`(?<![${LN}._%+-])@([${LN}_]+(?:\\.[${LN}_]+)*)`, "gu");
const USSD_RE = /\*\d+(?:\*\d+)*#/g;
const PLATFORM_RE = /\b(instagram|insta|facebook|fb|tiktok|whatsapp|telegram|twitter|snapchat|linkedin|youtube)\b/g;

/** The value of any Unicode decimal digit: digit blocks are runs of ten starting at zero. */
function digitValue(ch: string): string {
  const cp = ch.codePointAt(0)!;
  let start = cp;
  while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
  return String((cp - start) % 10);
}

export function normaliseForContacts(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[。｡．]/g, ".")
    .replace(/\p{Nd}/gu, (d) => (/[0-9]/.test(d) ? d : digitValue(d)))
    .toLowerCase()
    .replace(/\s*[[({]\s*(?:dot|\.)\s*[\])}]\s*/g, ".")
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/g, "@")
    .replace(new RegExp(`([${LN}])\\s+(?:dot|\\.)\\s+(?=[${L}]{2,})`, "gu"), "$1.");
}

interface Contacts {
  url: Set<string>;
  email: Set<string>;
  domain: Set<string>;
  phone: Set<string>;
  ussd: Set<string>;
  handle: Set<string>;
  platform: Set<string>;
}

/** Digits in order with their positions, and every 7-digit window that fits in 25 characters. */
function phones(t: string): Set<string> {
  const digits = [...t.matchAll(/\d/g)].map((m) => ({ at: m.index!, d: m[0] }));
  const out = new Set<string>();
  // A cluster: digits no more than 5 characters apart. A phone is a cluster
  // with 7+ digits, or any 7 digits inside 25 characters (then the cluster(s) they span).
  const clusters: Array<{ from: number; to: number }> = [];
  digits.forEach((x, i) => {
    const last = clusters[clusters.length - 1];
    if (last && x.at - digits[i - 1].at <= 6) last.to = i;
    else clusters.push({ from: i, to: i });
  });
  const clusterOf = (i: number) => clusters.findIndex((c) => i >= c.from && i <= c.to);
  for (let i = 0; i + 6 < digits.length; i++) {
    if (digits[i + 6].at - digits[i].at >= 25) continue;
    const a = clusters[clusterOf(i)];
    const b = clusters[clusterOf(i + 6)];
    out.add(digits.slice(a.from, b.to + 1).map((x) => x.d).join(""));
  }
  return out;
}

const trimEnd = (s: string) => s.replace(/[.\-_]+$/, "");

function extract(raw: string): Contacts {
  const t = normaliseForContacts(raw);
  const emails = [...t.matchAll(EMAIL_RE)];
  return {
    url: new Set([...t.matchAll(URL_RE)].map((m) => m[0].replace(/^https?:\/\//, "").replace(/^www\./, ""))),
    email: new Set(emails.map((m) => m[0])),
    domain: new Set([...t.matchAll(DOMAIN_RE)].map((m) => m[0]).map((d) => d.replace(/^www\./, ""))),
    phone: phones(t),
    ussd: new Set(t.match(USSD_RE) ?? []),
    handle: new Set([...t.matchAll(HANDLE_RE)].map((m) => trimEnd(m[1]))),
    platform: new Set((t.match(PLATFORM_RE) ?? []).map((p) => (p === "insta" ? "instagram" : p === "fb" ? "facebook" : p))),
  };
}

/** The first kind of contact in `text` that `guidelines` did not supply, or null. */
export function unsuppliedContact(text: string, guidelines: string | null): ContactKind | null {
  const found = extract(text);
  const allowed = extract(guidelines ?? "");
  // A URL's host must be a supplied domain; its path is then the business's own.
  for (const host of found.url) if (!allowed.domain.has(host) && !allowed.url.has(host)) return "url";
  const order: Array<Exclude<ContactKind, "url">> = ["email", "domain", "phone", "ussd", "handle", "platform"];
  for (const kind of order) {
    for (const token of found[kind]) if (!allowed[kind].has(token)) return kind;
  }
  return null;
}
