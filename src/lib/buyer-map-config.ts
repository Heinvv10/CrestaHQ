/**
 * Shared shape + defaults for the landing page's "Buyer World Map" section —
 * the flat-map choropleth of where LeadStack agencies have bought, plus the
 * country leaderboard modal. Persisted at `appConfig/buyerWorldMap`
 * (server-only writes via the Admin SDK; read server-side by the landing page
 * and live via the client hook on the /agency/landing editor).
 *
 * This file holds ONLY the operator-editable copy + toggle. The actual buyer
 * geography (which countries/cities, at what intensity) is a separate cached
 * aggregate — see src/lib/landing/buyer-map-data.ts. The headline copy here is
 * deliberately decoupled from the live counts: the stat tiles carry the real
 * numbers, the headline is marketing copy the operator maintains.
 *
 * Kept free of client-only imports so both the server component and the client
 * hook can import it.
 */
export interface BuyerMapConfig {
  /** Master on/off. When false the section never renders on the landing. */
  enabled: boolean;
  /** Small uppercase kicker above the heading. */
  eyebrow: string;
  /** Heading lead-in (regular weight), e.g. "Bought by agencies across". */
  headingLead: string;
  /** Heading emphasis (serif italic accent), e.g. "five continents." */
  headingEmphasis: string;
  /**
   * Privacy floor: a city is only plotted / listed when it has at least this
   * many buyers, so a single buyer's town isn't pinpointed. 1 = show all.
   */
  minCityBuyers: number;
  /** Show the "Total saved vs GoHighLevel" count-up. */
  showSavings: boolean;
  /**
   * Assumed annual spend a buyer avoids by owning LeadStack instead of renting
   * GHL. Total saved = buyer count × this. Editable — buyers reported ~$22k/yr.
   */
  annualSavingsPerBuyer: number;
}

/**
 * Defaults mirror the mock-up copy and ship the section OFF — it's opt-in, so
 * a fresh deployment (or one without enough buyers to look impressive) doesn't
 * show a near-empty map until the operator turns it on from /agency/landing.
 */
export const BUYER_MAP_DEFAULTS: BuyerMapConfig = {
  enabled: false,
  eyebrow: "Owned, not rented",
  headingLead: "Their own CRM, launched across",
  headingEmphasis: "five continents.",
  minCityBuyers: 1,
  showSavings: true,
  annualSavingsPerBuyer: 22000,
};

/** Normalize an untrusted Firestore payload to a complete, valid config. */
export function coerceBuyerMapConfig(
  data: Partial<BuyerMapConfig> | undefined | null,
): BuyerMapConfig {
  if (!data) return { ...BUYER_MAP_DEFAULTS };
  const strOr = (v: unknown, fallback: string, max: number) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback;
  return {
    enabled:
      typeof data.enabled === "boolean"
        ? data.enabled
        : BUYER_MAP_DEFAULTS.enabled,
    eyebrow: strOr(data.eyebrow, BUYER_MAP_DEFAULTS.eyebrow, 80),
    headingLead: strOr(data.headingLead, BUYER_MAP_DEFAULTS.headingLead, 120),
    headingEmphasis: strOr(
      data.headingEmphasis,
      BUYER_MAP_DEFAULTS.headingEmphasis,
      120,
    ),
    minCityBuyers:
      typeof data.minCityBuyers === "number" &&
      Number.isInteger(data.minCityBuyers) &&
      data.minCityBuyers >= 1
        ? Math.min(data.minCityBuyers, 100)
        : BUYER_MAP_DEFAULTS.minCityBuyers,
    showSavings:
      typeof data.showSavings === "boolean"
        ? data.showSavings
        : BUYER_MAP_DEFAULTS.showSavings,
    annualSavingsPerBuyer:
      typeof data.annualSavingsPerBuyer === "number" &&
      Number.isFinite(data.annualSavingsPerBuyer) &&
      data.annualSavingsPerBuyer >= 0
        ? Math.round(data.annualSavingsPerBuyer)
        : BUYER_MAP_DEFAULTS.annualSavingsPerBuyer,
  };
}
