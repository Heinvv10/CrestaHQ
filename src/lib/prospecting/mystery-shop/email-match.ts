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

const msgId = (v: unknown) => (typeof v === "string" ? v.trim().replace(/^<|>$/g, "") : "");

export function decideEmail(m: InboundEmail, shops: EmailShopCandidate[]): Map<string, EmailDecision> {
  const out = new Map<string, EmailDecision>(shops.map((s) => [s.id, "none"]));
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
