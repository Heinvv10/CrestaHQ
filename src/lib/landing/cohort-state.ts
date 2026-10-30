/**
 * Shape + coercion for the live deal campaign state stored on
 * `appConfig/foundersCohort` — shared by BOTH readers of that doc:
 *
 *   - the client hook ({@link import("@/hooks/use-founders-cohort")}), which
 *     subscribes via onSnapshot so edits land live, and
 *   - the server reader (`deal-state-server.ts`), which resolves the same
 *     state during SSR so the landing's FIRST PAINT already shows the right
 *     price.
 *
 * Both paths MUST agree — before this module existed the coercion lived only
 * in the hook, so the server had nothing to render from and every visitor saw
 * the deal price ($891 / "Claim your spot") for the ~1-3s the Firestore
 * subscription took to connect, then watched it jump to $1,782 retail. A
 * price that visibly INCREASES on load is the worst possible first
 * impression, hence the shared coercion + the server seed.
 *
 * Deliberately framework-neutral (no "use client", no server-only) so it can
 * be imported from either side.
 */

import { DEAL } from "@/config/deal";
import {
  DEAL_CONFIG_DEFAULTS,
  isValidTimeZone,
  type DealType,
} from "@/lib/deal-config";

export interface FoundersCohortState {
  soldCount: number;
  currentWave: 1 | 2 | 3;
  slotsTotal: number;
  /** Live campaign name (appConfig/foundersCohort.dealName), falls back to DEAL.name. */
  dealName: string;
  /** Live scarcity noun (…/foundersCohort.memberNoun), falls back to DEAL.memberNoun. */
  memberNoun: string;
  /** Urgency mechanic (…/foundersCohort.dealType). Missing field = "spots". */
  dealType: DealType;
  /** Countdown deadline as epoch ms (…/foundersCohort.dealEndsAt), null when unset. */
  dealEndsAtMs: number | null;
  /**
   * IANA zone the deadline was authored in (…/foundersCohort.dealEndsTimeZone).
   * Only affects how the deadline DATE is written ("31 July 2026 (AEST)") —
   * the countdown itself is an absolute instant. null = format in the
   * visitor's own zone with no label (pre-timezone-picker behavior).
   */
  dealEndsTimeZone: string | null;
  /** Countdown offer copy (…/foundersCohort.offerLabel), e.g. "50% off". */
  offerLabel: string;
  /** When true, an ENDED deal switches CTAs to the full-price checkout. */
  fullPriceAfterEnd: boolean;
  /** Master "end all deals" switch — retail $1,782 everywhere, right now. */
  retailMode: boolean;
  /** Announcement-bar copy shown while `retailMode` is on. */
  retailBannerMessage: string;
  /**
   * True once the state reflects the real doc — either from the server seed
   * (first paint) or from the client subscription. Every price/urgency
   * surface gates on this, so it must NEVER be true for guessed defaults.
   */
  hydrated: boolean;
}

/** Compile-time fallbacks. `hydrated: false` — these are guesses, not the doc. */
export const COHORT_DEFAULTS: FoundersCohortState = {
  soldCount: 0,
  currentWave: 1,
  slotsTotal: DEAL.seatsTotal,
  dealName: DEAL.name,
  memberNoun: DEAL.memberNoun,
  dealType: DEAL_CONFIG_DEFAULTS.dealType,
  dealEndsAtMs: null,
  dealEndsTimeZone: DEAL_CONFIG_DEFAULTS.dealEndsTimeZone,
  offerLabel: DEAL_CONFIG_DEFAULTS.offerLabel,
  fullPriceAfterEnd: DEAL_CONFIG_DEFAULTS.fullPriceAfterEnd,
  retailMode: DEAL_CONFIG_DEFAULTS.retailMode,
  retailBannerMessage: DEAL_CONFIG_DEFAULTS.retailBannerMessage,
  hydrated: false,
};

// Manual offset for off-Stripe sales (e.g. Skool, invoiced deals) the
// Stripe webhook can't see. Added on top of the real Stripe count, then
// capped at slotsTotal so we never display more than the cohort cap.
// Bump this env value each time you close a sale outside Stripe.
const MANUAL_SOLD = (() => {
  const raw = process.env.NEXT_PUBLIC_FOUNDERS_MANUAL_SOLD;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();

export function applyManualOffset(
  realFromStripe: number,
  slotsTotal: number,
): number {
  return Math.min(realFromStripe + MANUAL_SOLD, slotsTotal);
}

/**
 * The state for a MISSING doc (fresh clone / never edited): code defaults,
 * but marked hydrated — "no doc" is a real answer, not an unknown.
 */
export function emptyCohortState(): FoundersCohortState {
  return {
    ...COHORT_DEFAULTS,
    soldCount: applyManualOffset(0, COHORT_DEFAULTS.slotsTotal),
    hydrated: true,
  };
}

/** Normalize an untrusted `appConfig/foundersCohort` payload into state. */
export function coerceCohortState(
  data: Record<string, unknown>,
): FoundersCohortState {
  const realSold = typeof data.soldCount === "number" ? data.soldCount : 0;
  const slotsTotal =
    typeof data.slotsTotal === "number" ? data.slotsTotal : DEAL.seatsTotal;
  const endsAtRaw =
    typeof data.dealEndsAt === "string" ? Date.parse(data.dealEndsAt) : NaN;

  return {
    soldCount: applyManualOffset(realSold, slotsTotal),
    currentWave:
      data.currentWave === 2 || data.currentWave === 3 ? data.currentWave : 1,
    slotsTotal,
    dealName:
      typeof data.dealName === "string" && data.dealName.trim()
        ? data.dealName.trim()
        : DEAL.name,
    memberNoun:
      typeof data.memberNoun === "string" && data.memberNoun.trim()
        ? data.memberNoun.trim()
        : DEAL.memberNoun,
    dealType: data.dealType === "countdown" ? "countdown" : "spots",
    dealEndsAtMs: Number.isFinite(endsAtRaw) ? endsAtRaw : null,
    dealEndsTimeZone:
      typeof data.dealEndsTimeZone === "string" &&
      isValidTimeZone(data.dealEndsTimeZone)
        ? data.dealEndsTimeZone
        : null,
    offerLabel:
      typeof data.offerLabel === "string" && data.offerLabel.trim()
        ? data.offerLabel.trim()
        : DEAL_CONFIG_DEFAULTS.offerLabel,
    fullPriceAfterEnd: data.fullPriceAfterEnd === true,
    retailMode: data.retailMode === true,
    retailBannerMessage:
      typeof data.retailBannerMessage === "string" &&
      data.retailBannerMessage.trim()
        ? data.retailBannerMessage.trim()
        : DEAL_CONFIG_DEFAULTS.retailBannerMessage,
    hydrated: true,
  };
}
