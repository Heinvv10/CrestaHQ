/**
 * Shared Next.js Data Cache tag for the landing's server-rendered deal state
 * (`appConfig/foundersCohort`). Kept in its own tiny module so the cached
 * reader (deal-state-server.ts) and the invalidation site (the Deal editor's
 * PATCH route) reference the SAME string and can never drift — same model as
 * buyer-map-cache.ts.
 *
 * Same doc the landing already subscribes to client-side, so a stale cache
 * self-corrects within a second of page load; the tag bust just makes an
 * operator's save show up in the FIRST paint immediately instead of after the
 * safety-net window. `soldCount` is console-managed (no write path to hook
 * an invalidation into) — the short revalidate below covers it.
 */

export const DEAL_STATE_TAG = "deal-state";

/** Safety-net revalidation (seconds) for edits made outside the Deal editor. */
export const DEAL_STATE_REVALIDATE_SECONDS = 300;
