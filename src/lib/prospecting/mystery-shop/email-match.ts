import { canSettleResponded, inWindow, toMs } from "./model";

/**
 * Does an inbound email close an open email mystery shop? Pure.
 *
 * The SENDER decides, never the thread: the reply must come from the target
 * address, or from another address at the target's domain when that domain
 * is the business's own (`targetDomainTrusted`, decided at send time against
 * its website — a gmail address proves nothing about a colleague). A matching
 * In-Reply-To / References header only picks which of several sender-matching
 * shops the reply belongs to; on its own (a forged header from anyone else)
 * it closes nothing. The reply must arrive inside [sentAt, sentAt + 24 h].
 * An automatic reply (headers, or an out-of-office subject) is recorded once
 * as `auto_reply` and the shop keeps waiting for a person.
 *
 * The From header is forgeable, so the Authentication-Results headers are
 * read too (`senderAuthenticated`). They never change the decision here; the
 * caller (inbound.ts) does not let a reply whose sender FAILED them settle
 * the shop — it is only noted (`authFailedReplyAt`) and a miss after it is
 * disputed. An email sender is never "verified".
 *
 * Anything that looks like a report (a bounce, a delay notice, a read
 * receipt, a postmaster message) is never a response or an auto-reply. Only a
 * STRICT hard bounce of this shop's own email marks it `bounced`: a
 * delivery-status report whose delivery-status part says `Action: failed`
 * for the target (or an Exchange NDR / X-Failed-Recipients naming it),
 * naming our Message-ID, inside the window. Mail from the target carrying
 * List-Id / List-Unsubscribe is automatic, unless it answers our own thread.
 */

export interface AutoReplyHeaders {
  autoSubmitted: string | null;
  xAutoreply: string | null;
  xAutorespond: string | null;
  precedence: string | null;
  /** Mailing-list headers: newsletters and bulk mail, never a person. */
  listId: string | null;
  listUnsubscribe: string | null;
}

export interface DsnSignals {
  contentType: string | null;
  msExchangeNdr: string | null;
  failedRecipients: string | null;
  /** The body and returned-headers parts' text, searched for our Message-ID (full parse only). */
  text: string;
  /** The message/delivery-status MIME part only (full parse only). */
  deliveryStatus: string;
}

/** What lib/comms/imap.ts reads from a message's headers for this matcher. */
export interface MailSignals {
  autoReply: AutoReplyHeaders;
  /** Every Authentication-Results header, topmost (the receiving server's) first. */
  authResults: string[];
  dsn: DsnSignals;
}

export interface InboundEmail extends MailSignals {
  from: string;
  inReplyTo: string | null;
  references: string[];
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
  /** The target's domain is the business's own (store.ts, at reserve). */
  targetDomainTrusted?: unknown;
}

export type EmailDecision = "responded" | "auto_reply" | "bounced" | "none";

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

export function senderMatches(from: string, target: string, domainTrusted: boolean): boolean {
  const f = from.trim().toLowerCase();
  const t = target.trim().toLowerCase();
  if (!f.includes("@") || !t.includes("@")) return false;
  if (f === t) return true;
  return domainTrusted && domainOf(f) === domainOf(t);
}

const DSN_SUBJECT = /\b(undeliverable|delivery status notification|mail delivery failed|returned mail|delivery has failed)\b/i;

/** Looks like a report (bounce, delay, receipt, postmaster mail), by its headers, sender or subject. */
export function isDeliveryReport(m: Pick<InboundEmail, "dsn" | "from" | "subject">): boolean {
  return (
    /^multipart\/report\b/i.test(m.dsn.contentType?.trim() ?? "") ||
    m.dsn.msExchangeNdr != null ||
    m.dsn.failedRecipients != null ||
    /^(mailer-daemon|postmaster)@/i.test(m.from.trim()) ||
    DSN_SUBJECT.test(m.subject)
  );
}

const AUTO_SUBJECT = /\b(out[ -]of[ -](the[ -])?office|automatic[ -]reply|auto[ -]?reply|auto[ -]?response|automatic[ -]response)\b/i;

/** RFC 3834 / common auto-responder signals. X-Auto-Response-Suppress is NOT one: people's Outlook sets it. */
export function isAutoReply(m: Pick<InboundEmail, "autoReply" | "subject">): boolean {
  return autoResponder(m) || isListMail(m);
}

function autoResponder(m: Pick<InboundEmail, "autoReply" | "subject">): boolean {
  const h = m.autoReply;
  const auto = h.autoSubmitted?.trim().toLowerCase();
  if (auto && auto !== "no") return true;
  if (h.xAutoreply != null || h.xAutorespond != null) return true;
  if (/^(auto_reply|bulk|junk)$/i.test(h.precedence?.trim() ?? "")) return true;
  return AUTO_SUBJECT.test(m.subject);
}

/** Mailing-list headers. Automatic — unless the mail answers our own thread (helpdesks add them to real replies). */
const isListMail = (m: Pick<InboundEmail, "autoReply">) => m.autoReply.listId != null || m.autoReply.listUnsubscribe != null;

export type SenderAuth = "fail" | "unknown";

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
 * The Authentication-Results verdict on the From domain. "fail": any header
 * says dmarc=fail, or a hard spf=fail in a header with no dmarc result and no
 * aligned dkim=pass. softfail and dmarc=none are never a fail (forwarders and
 * Google Workspace relays produce them for real senders). A real host's fail
 * is genuine, and a sender will not inject a fail against itself. There is no
 * "pass": we cannot know whether the receiving host stamps its own header, so
 * a topmost dmarc=pass may be the sender's own injected one. Everything else
 * is "unknown".
 */
export function senderAuthenticated(authResults: string[], fromDomain: string): SenderAuth {
  const parsed = authResults.map(parseAuthResults);
  for (const results of parsed) {
    if (results.some((r) => r.method === "dmarc" && r.result === "fail")) return "fail";
    const spfFail = results.some((r) => r.method === "spf" && r.result === "fail");
    const dmarcResult = results.some((r) => r.method === "dmarc");
    if (spfFail && !dmarcResult && !results.some((r) => dkimAligned(r, fromDomain))) return "fail";
  }
  return "unknown";
}

const lower = (v: string) => v.trim().toLowerCase();

/** The delivery-status part reports a hard failure for `target` (a block without a Final-Recipient counts). */
function failedFor(deliveryStatus: string, target: string): boolean {
  return deliveryStatus.split(/\r?\n[ \t]*\r?\n/).some((block) => {
    if (!/^action:[ \t]*failed[ \t]*$/im.test(block)) return false;
    const rcpt = /^final-recipient:[ \t]*(.*)$/im.exec(block)?.[1];
    return rcpt === undefined || lower(rcpt.replace(/^rfc822;/i, "")) === lower(target);
  });
}

/** A strict hard bounce of mail to `target`. Delay notices, receipts and look-alikes are not. */
export function bouncedFor(dsn: DsnSignals, target: string): boolean {
  const ct = dsn.contentType ?? "";
  const report = /^multipart\/report\b/i.test(ct.trim()) && /report-type\s*=\s*"?delivery-status\b/i.test(ct);
  return (
    (report && failedFor(dsn.deliveryStatus, target)) ||
    lower(dsn.msExchangeNdr ?? "") === "true" ||
    (dsn.failedRecipients ?? "").split(/[,;\s]+/).map(lower).includes(lower(target))
  );
}

const msgId = (v: unknown) => (typeof v === "string" ? v.trim().replace(/^<|>$/g, "") : "");

export function decideEmail(m: InboundEmail, shops: EmailShopCandidate[]): Map<string, EmailDecision> {
  const out = new Map<string, EmailDecision>(shops.map((s) => [s.id, "none"]));
  const thread = new Set([m.inReplyTo, ...m.references].map(msgId).filter(Boolean));
  if (isDeliveryReport(m)) {
    for (const s of shops) {
      const ref = msgId(s.providerRef);
      const named = !!ref && (thread.has(ref) || m.dsn.text.includes(ref));
      const sent = toMs(s.sentAt);
      const timely = sent !== null && inWindow(sent, m.occurredAtMs);
      if (named && timely && (s.status === "sent" || s.status === "missed") && bouncedFor(m.dsn, s.target)) {
        out.set(s.id, "bounced");
      }
    }
    return out;
  }
  const responder = autoResponder(m);
  const list = isListMail(m);
  const auto = (s: EmailShopCandidate) => responder || (list && !thread.has(msgId(s.providerRef)));
  const eligible = shops.filter((s) => {
    if (!senderMatches(m.from, s.target, s.targetDomainTrusted === true)) return false;
    if (!auto(s)) return canSettleResponded(s, m.occurredAtMs);
    const sent = toMs(s.sentAt);
    return s.status === "sent" && s.autoReplyAt == null && sent !== null && inWindow(sent, m.occurredAtMs);
  });
  const inThread = eligible.filter((s) => thread.has(msgId(s.providerRef)));
  for (const s of inThread.length ? inThread : eligible) out.set(s.id, auto(s) ? "auto_reply" : "responded");
  return out;
}
