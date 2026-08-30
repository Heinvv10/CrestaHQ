/**
 * Shared shape + defaults for the live-editable deal campaign — the deal
 * name, the urgency mechanic (spots counter OR countdown timer), the
 * scarcity-counter noun ("spots"), the seat count, and the countdown's
 * deadline + offer label shown across every landing surface (hero, pricing
 * card, announcement bar, CTAs, FAQ).
 *
 * Persisted on the EXISTING `appConfig/foundersCohort` doc (fields `dealName`,
 * `memberNoun`, `slotsTotal`, `dealType`, `dealEndsAt`, `offerLabel`) — the
 * same publicly-readable doc the scarcity counter already reads live via
 * {@link useFoundersCohort}, so no new Firestore rules are needed.
 * Server-only writes via /api/agency/deal-config (Admin SDK). Code defaults
 * come from `src/config/deal.ts`; the doc overrides them the moment the
 * agency owner saves once. Mirrors the updates-modal config feature.
 *
 * The two urgency mechanics are mutually exclusive by construction —
 * `dealType` is a single enum, so exactly one renders at a time:
 *   - "spots":     today's "{sold} of {total} {noun} claimed" counter.
 *   - "countdown": a ticking deadline ("{offerLabel} until {date}").
 *     When the deadline passes, urgency UI hides but the page KEEPS
 *     SELLING at the same price (operator-chosen behavior) — relaunch by
 *     saving a new date.
 *
 * Deliberately NOT here: soldCount / currentWave (Stripe-webhook-owned — the
 * editor never writes them) and prices (kept inline in components by design;
 * see src/config/deal.ts).
 */

import { DEAL } from "@/config/deal";

export type DealType = "spots" | "countdown";

export interface DealConfig {
  /** Campaign name — headlines, badges, pricing-card title, FAQ. */
  dealName: string;
  /** Which urgency mechanic the landing renders. Missing field = "spots". */
  dealType: DealType;
  /** Plural noun in the scarcity counter: "{sold} of {total} {noun} claimed". */
  memberNoun: string;
  /** Cohort size — the live override of DEAL.seatsTotal. */
  slotsTotal: number;
  /**
   * Countdown deadline as an ISO-8601 string (UTC instant), or null when
   * unset. Ignored in "spots" mode. A past date = timer hidden, still selling.
   */
  dealEndsAt: string | null;
  /**
   * The IANA zone {@link dealEndsAt}'s wall clock was authored in, e.g.
   * "Australia/Sydney" or "America/Los_Angeles". The stored deadline is
   * already an absolute UTC instant, so this NEVER changes when the deal
   * ends — it only decides (a) which wall clock the editor shows when the
   * agency owner reopens the card, and (b) the zone the public deadline
   * date is rendered in ("until 31 July 2026 (AEST)"). null = legacy /
   * unset: the editor falls back to the browser's zone and the landing
   * formats the date in each visitor's own zone with no label.
   */
  dealEndsTimeZone: string | null;
  /** Countdown offer line, e.g. "50% off" — display copy only, never pricing. */
  offerLabel: string;
  /**
   * When true and the deal has ENDED (countdown expired, or spots sold out),
   * CTAs switch to a full-price $1,782 Stripe checkout (coupon-code box
   * enabled) — enforced server-side in /api/checkout/founders. When false:
   * countdown keeps selling at the deal price after expiry; sold-out spots
   * shows the contact-us card (today's behavior).
   */
  fullPriceAfterEnd: boolean;
  /**
   * Master "end all deals" switch. When true the whole landing flips to
   * retail immediately — INDEPENDENT of the deadline / spots-sold state:
   * every CTA sells the $1,782 Stripe checkout (server-enforced), all
   * urgency UI hides, the announcement bar shows `retailBannerMessage`, and
   * the pricing card renders at retail. Overrides `fullPriceAfterEnd` /
   * `dealHasEnded` — it doesn't wait for the deal to end, it ends it. Flip
   * it back off to resume deal pricing exactly as before.
   */
  retailMode: boolean;
  /**
   * The single announcement-bar message shown while `retailMode` is on
   * (the deal-specific "$891 · Save 50%" copy would be wrong at retail).
   * Editable live; falls back to {@link DEFAULT_RETAIL_BANNER_MESSAGE}.
   */
  retailBannerMessage: string;
}

/** Hard caps so an untrusted payload can't bloat the doc or break layouts. */
export const DEAL_NAME_MAX = 60;
export const DEAL_MEMBER_NOUN_MAX = 24;
export const DEAL_SEATS_MIN = 1;
export const DEAL_SEATS_MAX = 10000;
export const DEAL_OFFER_LABEL_MAX = 40;
export const RETAIL_BANNER_MAX = 90;

/** Seed copy for the retail-mode announcement bar; editable in the Deal card. */
export const DEFAULT_RETAIL_BANNER_MESSAGE =
  "Join the movement — stop renting your software. Own your stack outright.";

export const DEAL_TYPES: readonly DealType[] = ["spots", "countdown"];

/** Shown until the agency owner saves once (or the doc/fields are missing). */
export const DEAL_CONFIG_DEFAULTS: DealConfig = {
  dealName: DEAL.name,
  dealType: "spots",
  memberNoun: DEAL.memberNoun,
  slotsTotal: DEAL.seatsTotal,
  dealEndsAt: null,
  dealEndsTimeZone: null,
  offerLabel: "50% off",
  fullPriceAfterEnd: false,
  retailMode: false,
  retailBannerMessage: DEFAULT_RETAIL_BANNER_MESSAGE,
};

/* ------------------------------------------------------------------ *
 * Countdown timezone
 *
 * The deadline itself is stored as an absolute UTC instant, so every
 * visitor already counts down to the same moment no matter where they
 * are. The zone below is purely about AUTHORING and DISPLAY: which wall
 * clock "11:58 PM" means when the agency owner types it, and which zone
 * the public "until 31 July 2026 (AEST)" line is rendered in.
 *
 * Pure Intl — no date library. Everything here is client-safe.
 * ------------------------------------------------------------------ */

/**
 * Curated picker list. Deliberately short (the full IANA set is ~400
 * entries and unusable in a native select) — every entry is a zone the
 * campaign is plausibly run from. Any other valid IANA id still round-
 * trips fine if it lands on the doc; the editor appends the operator's
 * own detected zone when it isn't already listed.
 */
export const DEAL_TIME_ZONES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "Australia/Sydney", label: "Sydney / Melbourne — AEST/AEDT" },
  { id: "Australia/Brisbane", label: "Brisbane — AEST" },
  { id: "Australia/Adelaide", label: "Adelaide — ACST/ACDT" },
  { id: "Australia/Perth", label: "Perth — AWST" },
  { id: "Pacific/Auckland", label: "Auckland — NZST/NZDT" },
  { id: "America/Los_Angeles", label: "Los Angeles — Pacific" },
  { id: "America/Denver", label: "Denver — Mountain" },
  { id: "America/Chicago", label: "Chicago — Central" },
  { id: "America/New_York", label: "New York — Eastern" },
  { id: "America/Sao_Paulo", label: "São Paulo — BRT" },
  { id: "Europe/London", label: "London — GMT/BST" },
  { id: "Europe/Berlin", label: "Berlin / Paris — CET/CEST" },
  { id: "Asia/Dubai", label: "Dubai — GST" },
  { id: "Asia/Kolkata", label: "India — IST" },
  { id: "Asia/Singapore", label: "Singapore" },
  { id: "Asia/Tokyo", label: "Tokyo — JST" },
  { id: "UTC", label: "UTC" },
];

/** True when the runtime's Intl accepts `id` as an IANA timezone. */
export function isValidTimeZone(id: string): boolean {
  if (!id.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: id });
    return true;
  } catch {
    return false;
  }
}

/** The runtime's own zone (the browser's, client-side). "UTC" on failure. */
export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

/** The calendar/clock fields `atMs` reads as inside `timeZone`. */
function zonedParts(timeZone: string, atMs: number) {
  let dtf = partsFormatterCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatterCache.set(timeZone, dtf);
  }
  const parts = dtf.formatToParts(new Date(atMs));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** `timeZone`'s UTC offset in ms at the instant `atMs` (DST-aware). */
function zoneOffsetMs(timeZone: string, atMs: number): number {
  const p = zonedParts(timeZone, atMs);
  const asIfUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asIfUtc - Math.floor(atMs / 1000) * 1000;
}

const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/**
 * `<input type="datetime-local">` value ("2026-07-31T23:58") read as a wall
 * clock in `timeZone` → the absolute UTC instant. Two passes because the
 * offset depends on the instant we're solving for; the second pass settles
 * DST boundaries (the first guess can land on the wrong side of a jump).
 */
export function wallClockToUtcMs(
  value: string,
  timeZone: string,
): number | null {
  const m = WALL_CLOCK_RE.exec(value);
  if (!m) return null;
  const asIfUtc = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  );
  if (!Number.isFinite(asIfUtc)) return null;
  const firstGuess = asIfUtc - zoneOffsetMs(timeZone, asIfUtc);
  return asIfUtc - zoneOffsetMs(timeZone, firstGuess);
}

/** UTC instant → `<input type="datetime-local">` value in `timeZone`. */
export function utcMsToWallClock(atMs: number, timeZone: string): string {
  const p = zonedParts(timeZone, atMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Locales tried in order when resolving a zone's short name. No single
 * locale abbreviates every zone (en-US calls Sydney "GMT+10"; en-AU calls
 * Los Angeles "GMT-7"), so take the first that yields a real abbreviation
 * and fall back to the plain offset. DST-aware — AEST vs AEDT, PST vs PDT.
 */
const ABBREVIATION_LOCALES = ["en-AU", "en-US", "en-GB"];

const zoneNameFormatterCache = new Map<string, Intl.DateTimeFormat | null>();

/**
 * Short zone name at a given instant: "AEST", "PDT", "GMT", "GMT+8".
 *
 * Formatters are cached because the landing re-derives the deadline copy on
 * every countdown tick — constructing Intl.DateTimeFormat once a second is
 * the expensive part; formatToParts on a cached one is not.
 */
export function timeZoneAbbreviation(timeZone: string, atMs: number): string {
  const at = new Date(atMs);
  const read = (locale: string, name: "short" | "shortOffset") => {
    const key = `${locale}|${timeZone}|${name}`;
    let dtf = zoneNameFormatterCache.get(key);
    if (dtf === undefined) {
      try {
        dtf = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: name });
      } catch {
        dtf = null; // invalid zone, or a runtime without `shortOffset`
      }
      zoneNameFormatterCache.set(key, dtf);
    }
    return dtf?.formatToParts(at).find((p) => p.type === "timeZoneName")?.value;
  };
  for (const locale of ABBREVIATION_LOCALES) {
    const value = read(locale, "short");
    // Bare "GMT"/"UTC" IS the abbreviation (London in winter); an offset
    // suffix means this locale has no name for the zone — keep looking.
    if (value && !/^(GMT|UTC)[+-]/.test(value)) return value;
  }
  return read("en-GB", "shortOffset") ?? read("en-GB", "short") ?? "";
}

function coerceDealEndsAt(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Normalize an untrusted Firestore payload to a complete, valid config. */
export function coerceDealConfig(
  data: Record<string, unknown> | undefined | null,
): DealConfig {
  if (!data) return { ...DEAL_CONFIG_DEFAULTS };

  const dealName =
    typeof data.dealName === "string" && data.dealName.trim()
      ? data.dealName.trim().slice(0, DEAL_NAME_MAX)
      : DEAL_CONFIG_DEFAULTS.dealName;

  const dealType: DealType =
    data.dealType === "countdown" ? "countdown" : "spots";

  const memberNoun =
    typeof data.memberNoun === "string" && data.memberNoun.trim()
      ? data.memberNoun.trim().slice(0, DEAL_MEMBER_NOUN_MAX)
      : DEAL_CONFIG_DEFAULTS.memberNoun;

  const rawSlots = data.slotsTotal;
  const slotsTotal =
    typeof rawSlots === "number" &&
    Number.isInteger(rawSlots) &&
    rawSlots >= DEAL_SEATS_MIN &&
    rawSlots <= DEAL_SEATS_MAX
      ? rawSlots
      : DEAL_CONFIG_DEFAULTS.slotsTotal;

  const dealEndsAt = coerceDealEndsAt(data.dealEndsAt);

  const dealEndsTimeZone =
    typeof data.dealEndsTimeZone === "string" &&
    isValidTimeZone(data.dealEndsTimeZone)
      ? data.dealEndsTimeZone
      : null;

  const offerLabel =
    typeof data.offerLabel === "string" && data.offerLabel.trim()
      ? data.offerLabel.trim().slice(0, DEAL_OFFER_LABEL_MAX)
      : DEAL_CONFIG_DEFAULTS.offerLabel;

  const retailBannerMessage =
    typeof data.retailBannerMessage === "string" &&
    data.retailBannerMessage.trim()
      ? data.retailBannerMessage.trim().slice(0, RETAIL_BANNER_MAX)
      : DEAL_CONFIG_DEFAULTS.retailBannerMessage;

  return {
    dealName,
    dealType,
    memberNoun,
    slotsTotal,
    dealEndsAt,
    dealEndsTimeZone,
    offerLabel,
    fullPriceAfterEnd: data.fullPriceAfterEnd === true,
    retailMode: data.retailMode === true,
    retailBannerMessage,
  };
}

/**
 * Whether the campaign has ENDED for full-price purposes: countdown mode =
 * deadline passed; spots mode = sold out. `soldCount` should already include
 * any manual offset the caller applies (see useFoundersCohort /
 * NEXT_PUBLIC_FOUNDERS_MANUAL_SOLD).
 */
export function dealHasEnded(
  config: Pick<DealConfig, "dealType" | "dealEndsAt" | "slotsTotal">,
  soldCount: number,
  nowMs: number,
): boolean {
  if (config.dealType === "countdown") {
    if (!config.dealEndsAt) return false;
    const ms = Date.parse(config.dealEndsAt);
    return Number.isFinite(ms) && ms <= nowMs;
  }
  return soldCount >= config.slotsTotal;
}
