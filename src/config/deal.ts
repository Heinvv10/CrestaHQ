/**
 * Current sales campaign — the CODE DEFAULTS for the deal's name, member
 * noun, and seat count.
 *
 * ⚠️ These are DEFAULTS only. The live values are edited in-app at
 * /agency/landing → the "Deal" card, which writes `dealName`, `memberNoun`,
 * and `slotsTotal` onto the `appConfig/foundersCohort` Firestore doc — every
 * landing surface (hero, pricing card, announcement bar, CTAs, FAQ, scarcity
 * counter) reads that doc live via useFoundersCohort, no deploy needed.
 * The values below only show until the doc has those fields (fresh clone /
 * Firebase unconfigured).
 *
 * Intentionally NOT editable in-app (kept inline in the components by design):
 *   - prices ($891 / $1,782) — change those in the pricing copy directly, so
 *     the displayed price can't drift from the Stripe price actually charged.
 *   - inclusion bullets on the pricing card.
 *
 * The INTERNAL plumbing keeps the legacy "founders" name on purpose
 * (route /api/checkout/founders, the use-founders-* hooks, the
 * STRIPE_FOUNDERS_PRICE_ID env var, the appConfig/foundersCohort Firestore
 * doc, and the Stripe `kind: "founders"` metadata). Those are invisible to
 * buyers and renaming them would break reconciliation of existing purchases.
 *
 * Starting a fresh campaign: change name/noun/seats in the Deal card, then
 * reset `soldCount` (and `currentWave` if used) on appConfig/foundersCohort
 * in the Firebase console — the editor deliberately never touches those.
 */
/**
 * Stripe Price for the FULL $1,782 retail license. Used by
 * /api/checkout/founders when the Deal editor's "sell at full price after
 * the deal ends" box is ticked and the campaign has ended (countdown
 * expired / spots sold out). `STRIPE_FULL_PRICE_ID` env var overrides this
 * per-deployment; the in-code default keeps the retail price next to the
 * other in-code prices so checkout can't silently drift. Price ids are not
 * secrets (they're visible on the Stripe-hosted checkout page).
 */
export const STRIPE_FULL_PRICE_ID_DEFAULT = "price_1Tu26VB4JsHmqRy5OBUrLIyJ";

export const DEAL = {
  /** Campaign name — headlines, badges, pricing-card title, FAQ. */
  name: "The New Era Deal",

  /** Plural noun in the scarcity counter: "{sold} of {total} {memberNoun} claimed". */
  memberNoun: "spots",

  /** Cohort size (code default; see the Firestore override note above). */
  seatsTotal: 25,
} as const;

/**
 * Prior campaigns that actually sold out, oldest first. Rendered as the
 * rotating "deal lineage" ticker above the hero's scarcity bar, so the live
 * counter reads as the latest drop in a proven track record instead of an
 * unverifiable number. Static history by design (not Firestore-editable):
 * when the CURRENT deal sells out and a new campaign starts (see the
 * campaign-reset note above), append the outgoing deal's name here.
 */
export const PAST_DEALS: ReadonlyArray<{ name: string }> = [
  // Lineage ticker hidden for now — uncomment to restore the sold-out
  // track record above the hero scarcity bar + in the pricing header.
  // { name: "Founders (100) Deal" },
  // { name: "New Era (25) Deal" },
];
