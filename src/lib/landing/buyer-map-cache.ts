/**
 * Shared Next.js Data Cache tags for the landing Buyer World Map. Kept in
 * their own tiny module so the cached readers (buyer-map-data.ts, the config
 * reader in app/page.tsx) and every invalidation site (the config PATCH route,
 * the purchase webhook, the manual-purchase route) reference the SAME strings
 * and can never drift.
 *
 * Invalidation model (see the project memory): the landing is high-traffic but
 * buyer data changes rarely, so nothing is read per view — both the config and
 * the aggregate are cached and only refreshed when something actually changes
 * (an operator save, or a new purchase), with a long time-based safety net.
 */

/** Aggregate of buyers by country/city (tiers). Busted on each new purchase. */
export const BUYER_MAP_DATA_TAG = "buyer-map";

/** The operator-editable copy + toggle. Busted on each editor save. */
export const BUYER_MAP_CONFIG_TAG = "buyer-map-config";

/** Safety-net revalidation (seconds) in case a tag invalidation is missed. */
export const BUYER_MAP_REVALIDATE_SECONDS = 3600;
