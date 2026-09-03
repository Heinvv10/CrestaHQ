/**
 * Landing-page configuration.
 *
 * The repo ships with two complete landing pages:
 *
 *   - "custom"    — a generic agency-CRM landing the buyer brands as
 *     their own. THIS IS THE DEFAULT — every new clone should be
 *     branded for the buyer's business, so the custom variant renders
 *     at "/" out of the box and CUSTOM_BRAND below should be edited
 *     first.
 *
 *     Wired for a DONE-FOR-YOU sales motion, not self-serve SaaS:
 *     prospects see a "Talk to us" mailto CTA (uses CUSTOM_BRAND.
 *     supportEmail), the owner takes payment off-system, provisions
 *     a sub-account, then invites the client via the in-app invite
 *     flow. Pricing tiers + section are hidden by default — see the
 *     CUSTOM_BRAND.pricing block below for how to re-enable real
 *     self-serve resale.
 *
 *   - "leadstack" — the LeadStack-branded marketing landing that sells
 *     LeadStack itself (used on the leadstack.dev demo site). Only flip
 *     back to this if you're running the public LeadStack demo.
 *
 * Flip LANDING_VARIANT below to swap which one renders at "/".
 */

export type LandingVariant = "leadstack" | "custom";

export const LANDING_VARIANT: LandingVariant = "custom";

export interface CustomPricingTier {
  name: string;
  priceMonthly: number;
  priceAnnual: number;
  blurb: string;
  features: readonly string[];
  cta: string;
  highlighted: boolean;
}

export interface CustomBrand {
  name: string;
  tagline: string;
  shortDescription: string;
  supportEmail: string;
  primaryDomain: string;
  pricing: {
    starter: CustomPricingTier;
    pro: CustomPricingTier;
    scale: CustomPricingTier;
  };
}

/**
 * The brand object actually passed to the custom landing components at
 * render time. Resolved on the server by lib/landing/resolve-brand.ts —
 * agency doc fields take precedence, CUSTOM_BRAND fills the gaps. `logoUrl`
 * is nullable because "no logo set" is a meaningful state (renders the
 * default gradient mark instead of an <img>).
 */
export interface ResolvedBrand {
  name: string;
  logoUrl: string | null;
  tagline: string;
  shortDescription: string;
  supportEmail: string;
  primaryDomain: string;
}

/**
 * Brand fields used by the "custom" landing variant. Ignored entirely when
 * LANDING_VARIANT is "leadstack". Edit these to brand the white-label
 * landing for your own business — the values below are placeholder
 * defaults so the page renders cleanly out of the box.
 */
export const CUSTOM_BRAND: CustomBrand = {
  /** Displayed in navbar, hero, footer copyright, page title — everywhere.
   *  Trading name. The legal entity (Brightsphere Technologies (Pty) Ltd,
   *  reg 2005/023519/07) belongs on invoices and the legal pages, not here. */
  name: "CrestaHQ",

  /** One-line positioning, surfaced in hero subtitle + meta description.
   *  Lifted verbatim from the crestahq.com hero eyebrow so the app and the
   *  marketing site say the same thing. */
  tagline: "Get found. Get chosen. Get back to work.",

  /** Short description under the hero headline. Also from crestahq.com. */
  shortDescription:
    "CrestaHQ replies to every enquiry in seconds, asks for the review once the job's done, and puts you at the top of what people find — including what AI tells them when they ask who to call.",

  /** Used on CTA buttons + the FAQ "talk to us" line + footer. */
  supportEmail: "info@crestahq.com",

  /** Used in footer, og:url, canonical. No https://, no trailing slash. */
  primaryDomain: "crestahq.com",

  /**
   * Pricing tiers. HIDDEN BY DEFAULT and deliberately left that way — the
   * CrestaHQ sales motion is done-for-you ("Book a 15-minute call"), not
   * self-serve checkout, which is exactly what this variant is wired for.
   * See the block comment above for the five steps to re-enable self-serve.
   *
   * Amounts are the recorded USD list prices (197 / 497 / 997). The
   * marketing site renders ZAR and GBP conversions at build time; this app
   * shows USD because there is no multi-currency renderer here.
   *
   * `priceAnnual` intentionally MATCHES the monthly figure — no annual
   * discount has been decided. Don't invent one; set it when it's a real
   * commercial decision.
   */
  pricing: {
    starter: {
      name: "Starter",
      priceMonthly: 197,
      priceAnnual: 197,
      blurb: "Set up once, then it runs without you.",
      features: [
        "Google review system on WhatsApp + SMS",
        "Missed-enquiry follow-up in under 60 seconds",
        "Google Business Profile kept accurate",
        "One workspace, one location",
        "Email support",
      ],
      cta: "Book a 15-minute call",
      highlighted: false,
    },
    pro: {
      name: "System",
      priceMonthly: 497,
      priceAnnual: 497,
      blurb: "The full engine — enquiries in, reviews out.",
      features: [
        "Everything in Starter",
        "AI agent answering chat, SMS and WhatsApp",
        "Pipeline, quotes and booking pages",
        "Local + AI search visibility (GEO/AEO)",
        "Multiple locations",
        "Priority support",
      ],
      cta: "Book a 15-minute call",
      highlighted: true,
    },
    scale: {
      name: "Growth",
      priceMonthly: 997,
      priceAnnual: 997,
      blurb: "For businesses where the phone has to ring.",
      features: [
        "Everything in System",
        "AI voice agent answering inbound calls",
        "Paid ads managed alongside the funnel",
        "Custom reporting on what actually converts",
        "Dedicated onboarding",
      ],
      cta: "Book a 15-minute call",
      highlighted: false,
    },
  },
};
