import { toMs, type MysteryShopChannel, type MysteryShopFailure, type MysteryShopStatus } from "./model";

/**
 * Mystery shops → report sections 11 (speed to lead: email, call, form) and
 * 12 (WhatsApp responsiveness), plus the card's status lines. Pure.
 *
 * The PUBLIC view (share page, its JSON) shows only settled outcomes —
 * responded or missed — and is built field by field: no target, target
 * label, provider ref, enquiry text or failure ever reaches it. The member
 * view adds the target and shows an open shop as waiting.
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
  /** How the response was seen, and whether its sender is proven (store.ts `ResponseVia`). Null until responded. */
  responseVia: "email" | "answered" | "callback" | null;
  senderAuth: "pass" | "unknown" | null;
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
    responseVia: (["email", "answered", "callback"] as const).find((v) => v === d.responseVia) ?? null,
    senderAuth: d.senderAuth === "pass" || d.senderAuth === "unknown" ? d.senderAuth : null,
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
  return { ...view, target: s.target, ...(outcome === "responded" && verified ? { verified } : {}) };
}

const SECTIONS: { key: MysteryShopSection["key"]; title: string; channels: MysteryShopChannel[] }[] = [
  { key: "speed_to_lead", title: "Speed to lead", channels: ["email", "call", "form"] },
  { key: "whatsapp_response", title: "WhatsApp responsiveness", channels: ["whatsapp"] },
];

/**
 * The newest shop per channel that the audience may see (public: responded
 * or missed; member: also queued/sent), as sections. A section with nothing
 * to show is left out, so no shops = no sections.
 */
export function mysteryShopSections(
  shops: MemberShop[],
  opts: { audience: "public" | "member"; nowMs: number; timeZone?: string },
): MysteryShopSection[] {
  const shown = new Set(opts.audience === "public" ? ["responded", "missed"] : ["responded", "missed", "queued", "sent"]);
  const newest = [...shops]
    .filter((s) => shown.has(s.status))
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
      return `${head}sent ${since(s.sentAt, nowMs)} ago, waiting for a reply (24 h)${
        s.autoReplyAt ? `; an automatic reply came after ${since(s.sentAt, Date.parse(s.autoReplyAt))}` : ""
      }`;
    case "responded": {
      const ok = s.senderAuth === "pass" ? "verified" : "unverified";
      return s.responseVia === "callback"
        ? `${head}called back after ${formatDuration(s.responseMs ?? 0)} (caller ID ${ok})`
        : `${head}responded in ${formatDuration(s.responseMs ?? 0)} (sender ${ok})`;
    }
    case "missed":
      return `${head}no reply in 24 h — ${formatMoney(s.jobValueCents, s.currency)} lead missed`;
    case "refused":
      return `${head}refused: ${s.failure?.reason ?? "not allowed"}`;
    default:
      return `${head}failed: ${s.failure?.reason ?? "the send did not go out"}`;
  }
}
