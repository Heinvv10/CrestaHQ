import { toMs, type MysteryShopChannel, type MysteryShopFailure, type MysteryShopStatus } from "./model";

/**
 * Mystery shops → report sections 11 (speed to lead: email, call, form) and
 * 12 (WhatsApp responsiveness), plus the card's status lines. Pure.
 *
 * The PUBLIC view (share page, its JSON) shows only settled outcomes and is
 * built field by field: no target, target label, provider ref, enquiry text
 * or failure ever reaches it. A response is public as soon as it is seen; a
 * MISS is public only once a member confirmed it (`missedConfirmedAt`) — the
 * automatic evidence of "no reply" can always be incomplete (a lost webhook,
 * a Junk folder, a callback from another number), so the operator checks
 * first. The member view adds the target, shows open and unconfirmed shops,
 * and carries the flags (disputed, send uncertain).
 */

/** A shop as the member API returns it: JSON-safe, timestamps ISO. */
export interface MemberShop {
  id: string;
  channel: MysteryShopChannel;
  status: MysteryShopStatus;
  target: string;
  sentAt: string | null;
  respondedAt: string | null;
  responseMs: number | null;
  autoReplyAt: string | null;
  jobValueCents: number;
  currency: string;
  enquiryText: string;
  failure: MysteryShopFailure | null;
  createdAt: string | null;
  /** How the response was seen, and whether its sender is proven (replies.ts `ResponseVia`). Null until responded. */
  responseVia: "email" | "answered" | "callback" | "whatsapp" | null;
  senderAuth: "pass" | "unknown" | null;
  /** The send may or may not have gone out (store.ts `markUncertain`). Such a miss cannot be confirmed, so it is never public. */
  sendUncertain: boolean;
  /** 24 h passed but the mailbox sync has not read that far yet (store.ts `settleMissed`). */
  awaitingSync: boolean;
  /** Missed after a reply that failed the sender check (store.ts `settleMissed`). A member flag. */
  disputed: boolean;
  /** A member confirmed the miss after checking: only then is it public. */
  missedConfirmedAt: string | null;
  /** WhatsApp delivery receipts (inbound.ts `recordMysteryShopWhatsAppStatus`). Member only. */
  deliveredAt: string | null;
  readAt: string | null;
}

export interface MysteryShopItem {
  channel: MysteryShopChannel;
  outcome: "responded" | "missed" | "waiting";
  text: string;
  note: string | null;
  disclosure: string;
  /** Member view only. */
  target?: string;
  /** Member view only, for a response: "Reply sender verified" / "unverified". */
  verified?: string;
}

export interface MysteryShopSection {
  key: "speed_to_lead" | "whatsapp_response";
  title: string;
  items: MysteryShopItem[];
}

const iso = (v: unknown) => {
  const ms = toMs(v);
  return ms === null ? null : new Date(ms).toISOString();
};
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function serializeShop(id: string, d: Record<string, unknown>): MemberShop {
  const f = d.failure as MysteryShopFailure | null | undefined;
  return {
    id,
    channel: d.channel as MysteryShopChannel,
    status: d.status as MysteryShopStatus,
    target: String(d.target ?? ""),
    sentAt: iso(d.sentAt),
    respondedAt: iso(d.respondedAt),
    responseMs: num(d.responseMs),
    autoReplyAt: iso(d.autoReplyAt),
    jobValueCents: num(d.jobValueCents) ?? 0,
    currency: String(d.currency ?? "ZAR"),
    enquiryText: String(d.enquiryText ?? ""),
    failure: f ? { code: String(f.code), reason: String(f.reason) } : null,
    createdAt: iso(d.createdAt),
    responseVia: (["email", "answered", "callback", "whatsapp"] as const).find((v) => v === d.responseVia) ?? null,
    senderAuth: d.senderAuth === "pass" || d.senderAuth === "unknown" ? d.senderAuth : null,
    sendUncertain: d.sendUncertain === true,
    awaitingSync: d.awaitingSync === true,
    disputed: d.disputed === true,
    missedConfirmedAt: iso(d.missedConfirmedAt),
    deliveredAt: iso(d.deliveredAt),
    readAt: iso(d.readAt),
  };
}

/** `2 h 14 m`, `2 h`, `45 m`, `38 s`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} m` : `${h} h`;
}

/** `R1,500`, `R1,500.50`; another currency is prefixed with its code. */
export function formatMoney(cents: number, currency: string): string {
  const whole = cents % 100 === 0;
  const n = new Intl.NumberFormat("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100);
  return currency === "ZAR" ? `R${n}` : `${currency} ${n}`;
}

const formatDay = (isoAt: string, timeZone: string) =>
  new Date(isoAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone });

const VIA: Record<MysteryShopChannel, string> = {
  email: "by email",
  call: "by phone",
  whatsapp: "on WhatsApp",
  form: "to the website form enquiry",
};
const LABEL: Record<MysteryShopChannel, string> = { email: "Email", call: "Call", whatsapp: "WhatsApp", form: "Form" };

const since = (fromIso: string | null, toMsAt: number) => formatDuration(toMsAt - (fromIso ? Date.parse(fromIso) : toMsAt));

function item(s: MemberShop, audience: "public" | "member", nowMs: number, timeZone: string): MysteryShopItem {
  const sent = s.sentAt ?? s.createdAt ?? new Date(nowMs).toISOString();
  const auto = s.autoReplyAt ? since(s.sentAt, Date.parse(s.autoReplyAt)) : null;
  const outcome = s.status === "responded" ? "responded" : s.status === "missed" ? "missed" : "waiting";
  const text =
    outcome === "responded"
      ? `Responded in ${formatDuration(s.responseMs ?? 0)} ${VIA[s.channel]}.`
      : outcome === "missed"
        ? `No response within 24 h — an estimated ${formatMoney(s.jobValueCents, s.currency)} lead missed.`
        : `Waiting for a reply (sent ${since(s.sentAt, nowMs)} ago).`;
  const note = !auto
    ? null
    : outcome === "missed"
      ? `An automatic acknowledgement arrived after ${auto}; no person replied within 24 h.`
      : `An automatic acknowledgement arrived after ${auto}.`;
  const view: MysteryShopItem = {
    channel: s.channel,
    outcome,
    text,
    note,
    disclosure: `This was a response-time test: a plain enquiry sent on ${formatDay(sent, timeZone)}.`,
  };
  if (audience === "public") return view;
  const verified = s.senderAuth ? `Reply sender ${s.senderAuth === "pass" ? "verified" : "unverified"}` : undefined;
  const member = { ...view, target: s.target, ...(outcome === "responded" && verified ? { verified } : {}) };
  const flags = [
    s.disputed ? "A reply arrived but failed the sender check." : null,
    outcome === "missed" && !s.missedConfirmedAt ? "Not confirmed: only confirmed misses appear on the public report." : null,
  ].filter(Boolean);
  return flags.length ? { ...member, note: flags.join(" ") } : member;
}

const SECTIONS: { key: MysteryShopSection["key"]; title: string; channels: MysteryShopChannel[] }[] = [
  { key: "speed_to_lead", title: "Speed to lead", channels: ["email", "call", "form"] },
  { key: "whatsapp_response", title: "WhatsApp responsiveness", channels: ["whatsapp"] },
];

/**
 * The newest shop per channel that the audience may see (public: responded,
 * or missed AND confirmed; member: also unconfirmed misses and queued/sent),
 * as sections. A section with nothing to show is left out, so no shops = no
 * sections.
 */
export function mysteryShopSections(
  shops: MemberShop[],
  opts: { audience: "public" | "member"; nowMs: number; timeZone?: string },
): MysteryShopSection[] {
  const shown = new Set(opts.audience === "public" ? ["responded", "missed"] : ["responded", "missed", "queued", "sent"]);
  const newest = [...shops]
    // The one public rule for a miss: a member confirmed it.
    .filter((s) => shown.has(s.status) && !(opts.audience === "public" && s.status === "missed" && !s.missedConfirmedAt))
    .sort((a, b) => (b.sentAt ?? b.createdAt ?? "").localeCompare(a.sentAt ?? a.createdAt ?? ""));
  return SECTIONS.map((sec) => ({
    key: sec.key,
    title: sec.title,
    items: sec.channels
      .map((c) => newest.find((s) => s.channel === c))
      .filter((s): s is MemberShop => !!s)
      .map((s) => item(s, opts.audience, opts.nowMs, opts.timeZone || "UTC")),
  })).filter((sec) => sec.items.length > 0);
}

/** The Reports card's one line per shop. */
export function shopStatusLine(s: MemberShop, nowMs: number): string {
  const head = `${LABEL[s.channel]} to ${s.target} — `;
  switch (s.status) {
    case "queued":
      return `${head}sending…`;
    case "sent":
      if (s.awaitingSync) return `${head}24 h passed; waiting for the mailbox sync to catch up before calling it missed`;
      return `${head}${s.sendUncertain ? "may have been sent" : "sent"} ${since(s.sentAt, nowMs)} ago${
        s.sendUncertain ? " (the send did not confirm)" : ""
      }${s.readAt ? ", read" : s.deliveredAt ? ", delivered" : ""}, waiting for a reply (24 h)${
        s.autoReplyAt ? `; an automatic reply came after ${since(s.sentAt, Date.parse(s.autoReplyAt))}` : ""
      }`;
    case "responded": {
      const ok = s.senderAuth === "pass" ? "verified" : "unverified";
      if (s.responseVia === "callback") return `${head}called back after ${formatDuration(s.responseMs ?? 0)} (caller ID ${ok})`;
      return `${head}responded in ${formatDuration(s.responseMs ?? 0)} (sender ${ok})`;
    }
    case "missed": {
      const flags = [
        s.disputed ? "a reply arrived but failed the sender check" : null,
        s.sendUncertain ? "send uncertain — may not have been delivered" : null,
      ].filter(Boolean);
      const tail = flags.length ? ` (${flags.join("; ")})` : "";
      if (s.missedConfirmedAt) return `${head}no reply in 24 h — ${formatMoney(s.jobValueCents, s.currency)} lead missed (confirmed)${tail}`;
      if (s.sendUncertain) return `${head}no reply detected in 24 h${tail}. It can't be published as a missed lead.`;
      return `${head}no reply detected in 24 h${tail}. Check the inbox, Junk folder and call log before confirming — only confirmed misses appear on the report.`;
    }
    case "refused":
      return `${head}refused: ${s.failure?.reason ?? "not allowed"}`;
    case "failed":
      if (s.failure?.code === "undeliverable") return `${head}undeliverable: ${s.failure.reason}`;
      return `${head}failed: ${s.failure?.reason ?? "the send did not go out"}`;
    default:
      return `${head}failed: ${s.failure?.reason ?? "the send did not go out"}`;
  }
}
