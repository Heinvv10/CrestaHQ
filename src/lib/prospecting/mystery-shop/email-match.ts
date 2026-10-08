import { canSettleResponded, inWindow, toMs } from "./model";

/**
 * Does an inbound email close an open email mystery shop? Pure.
 *
 * The SENDER decides, never the thread: the reply must come from the target
 * address, or from the target's own domain — unless that domain is a public
 * mailbox provider, where a shared domain proves nothing. A matching
 * In-Reply-To / References header only picks which of several sender-matching
 * shops the reply belongs to; on its own (a forged header from anyone else)
 * it closes nothing. The reply must arrive inside [sentAt, sentAt + 24 h].
 * An automatic reply (headers, or an out-of-office subject) is recorded once
 * as `auto_reply` and the shop keeps waiting for a person.
 *
 * The From header is forgeable, so the receiving server's
 * Authentication-Results are read too (`senderAuthenticated`): a sender that
 * FAILS them closes nothing and records nothing. Absent results ("unknown" —
 * many small hosts never stamp them) behave as before; the member view shows
 * such a reply as unverified.
 */

export interface AutoReplyHeaders {
  autoSubmitted: string | null;
  xAutoreply: string | null;
  xAutorespond: string | null;
  precedence: string | null;
}

export interface InboundEmail {
  from: string;
  inReplyTo: string | null;
  references: string[];
  autoReply: AutoReplyHeaders;
  /** Every Authentication-Results header, topmost (the receiving server's) first. */
  authResults: string[];
  subject: string;
  occurredAtMs: number;
}

export interface EmailShopCandidate {
  id: string;
  target: string;
  status: unknown;
  sentAt: unknown;
  respondedAt: unknown;
  autoReplyAt: unknown;
  providerRef: unknown;
}

export type EmailDecision = "responded" | "auto_reply" | "none";

/** Domains where two addresses sharing the domain are unrelated people. */
const PUBLIC_EXACT: ReadonlySet<string> = new Set([
  "proton.me", "protonmail.com", "pm.me", "zoho.com", "mail.com", "yandex.com", "me.com", "mac.com",
  "mweb.co.za", "telkomsa.net", "webmail.co.za", "vodamail.co.za", "iafrica.com", "absamail.co.za",
  "lantic.net", "afrihost.co.za", "cybersmart.co.za", "polka.co.za", "xsinet.co.za",
]);
/** Provider families under any country TLD: gmail.com, hotmail.co.uk, yahoo.co.za, gmx.de … */
const PUBLIC_FAMILIES: ReadonlySet<string> = new Set([
  "gmail", "googlemail", "outlook", "hotmail", "live", "msn", "yahoo", "ymail", "rocketmail",
  "icloud", "aol", "gmx",
]);

export function isPublicMailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return PUBLIC_EXACT.has(d) || PUBLIC_FAMILIES.has(d.split(".")[0] ?? "");
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

export function senderMatches(from: string, target: string): boolean {
  const f = from.trim().toLowerCase();
  const t = target.trim().toLowerCase();
  if (!f.includes("@") || !t.includes("@")) return false;
  if (f === t) return true;
  const domain = domainOf(t);
  return domainOf(f) === domain && !isPublicMailDomain(domain);
}

const AUTO_SUBJECT = /\b(out[ -]of[ -](the[ -])?office|automatic[ -]reply|auto[ -]?reply|auto[ -]?response|automatic[ -]response)\b/i;

/** RFC 3834 / common auto-responder signals. X-Auto-Response-Suppress is NOT one: people's Outlook sets it. */
export function isAutoReply(m: Pick<InboundEmail, "autoReply" | "subject">): boolean {
  const h = m.autoReply;
  const auto = h.autoSubmitted?.trim().toLowerCase();
  if (auto && auto !== "no") return true;
  if (h.xAutoreply != null || h.xAutorespond != null) return true;
  if (/^(auto_reply|bulk|junk)$/i.test(h.precedence?.trim() ?? "")) return true;
  return AUTO_SUBJECT.test(m.subject);
}

export type SenderAuth = "pass" | "fail" | "unknown";

type AuthResult = { method: string; result: string; props: Record<string, string> };

/** One Authentication-Results value → its method results. Comments are dropped; the authserv-id is skipped. */
function parseAuthResults(header: string): AuthResult[] {
  return header
    .replace(/\([^)]*\)/g, " ")
    .split(";")
    .slice(1)
    .flatMap((part) => {
      const [head, ...rest] = part.trim().split(/\s+/);
      const m = /^([a-z0-9-]+)=([a-z]+)$/i.exec(head ?? "");
      if (!m) return [];
      const props = Object.fromEntries(
        rest.flatMap((kv) => {
          const i = kv.indexOf("=");
          return i > 0 ? [[kv.slice(0, i).toLowerCase(), kv.slice(i + 1).toLowerCase()]] : [];
        }),
      );
      return [{ method: m[1].toLowerCase(), result: m[2].toLowerCase(), props }];
    });
}

/** Two-label public suffixes like co.za / com.au: never an organisational domain of their own. */
const PUBLIC_SUFFIX_2 = /^(co|com|org|net|ac|gov|edu|ltd|plc|web)\.[a-z]{2}$/;

/** Relaxed DMARC-style alignment: the same domain, or one a subdomain of the other — never via a public suffix. */
export function domainsAlign(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/^@/, "").replace(/.*@/, "");
  const y = b.toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const [longer, shorter] = x.length > y.length ? [x, y] : [y, x];
  return longer.endsWith(`.${shorter}`) && shorter.includes(".") && !PUBLIC_SUFFIX_2.test(shorter);
}

const dkimAligned = (r: AuthResult, fromDomain: string) =>
  r.method === "dkim" && r.result === "pass" &&
  [r.props["header.d"], r.props["header.i"]].some((d) => !!d && domainsAlign(d, fromDomain));

/**
 * The receiving server's verdict on the From domain. "fail": any header says
 * dmarc=fail, or spf=fail/softfail with no aligned dkim=pass in that same
 * header. "pass" (read from the TOPMOST header only — the one our receiving
 * server added; a lower one may be supplied by the sender): dmarc=pass,
 * aligned dkim=pass, or spf=pass with an aligned smtp.mailfrom. Else unknown.
 */
export function senderAuthenticated(authResults: string[], fromDomain: string): SenderAuth {
  const parsed = authResults.map(parseAuthResults);
  for (const results of parsed) {
    if (results.some((r) => r.method === "dmarc" && r.result === "fail")) return "fail";
    const spfFail = results.some((r) => r.method === "spf" && (r.result === "fail" || r.result === "softfail"));
    if (spfFail && !results.some((r) => dkimAligned(r, fromDomain))) return "fail";
  }
  const top = parsed[0] ?? [];
  const pass = top.some(
    (r) =>
      (r.method === "dmarc" && r.result === "pass" && (!r.props["header.from"] || domainsAlign(r.props["header.from"], fromDomain))) ||
      dkimAligned(r, fromDomain) ||
      (r.method === "spf" && r.result === "pass" && !!r.props["smtp.mailfrom"] && domainsAlign(r.props["smtp.mailfrom"], fromDomain)),
  );
  return pass ? "pass" : "unknown";
}

const msgId = (v: unknown) => (typeof v === "string" ? v.trim().replace(/^<|>$/g, "") : "");

export function decideEmail(m: InboundEmail, shops: EmailShopCandidate[]): Map<string, EmailDecision> {
  const out = new Map<string, EmailDecision>(shops.map((s) => [s.id, "none"]));
  if (senderAuthenticated(m.authResults, domainOf(m.from)) === "fail") return out;
  const auto = isAutoReply(m);
  const eligible = shops.filter((s) => {
    if (!senderMatches(m.from, s.target)) return false;
    if (!auto) return canSettleResponded(s, m.occurredAtMs);
    const sent = toMs(s.sentAt);
    return s.status === "sent" && s.autoReplyAt == null && sent !== null && inWindow(sent, m.occurredAtMs);
  });
  const thread = new Set([m.inReplyTo, ...m.references].map(msgId).filter(Boolean));
  const inThread = eligible.filter((s) => thread.has(msgId(s.providerRef)));
  for (const s of inThread.length ? inThread : eligible) out.set(s.id, auto ? "auto_reply" : "responded");
  return out;
}
