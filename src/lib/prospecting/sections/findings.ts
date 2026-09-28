import type { ProspectFinding, ProspectFindingCode } from "@/types";

/**
 * A section's score comes only from its findings: 100 minus the deductions
 * of the findings it raised, floored at 0. So a score below 100 always has a
 * reason on the page. Values and rationale:
 * docs/parity/evidence/prospecting-r0b/deduction-table.md.
 *
 * Thresholds on one measure never stack: the scorer raises only the stricter
 * code (`low_rating` instead of `rating_under_4_8`, `few_reviews` instead of
 * `reviews_under_50`, `slow_mobile` instead of `lcp_needs_improvement`).
 *
 * Codes that are never emitted today (`gbp_unclaimed`, `gbp_no_description`,
 * `listing_missing`, `no_ads_running`) still carry a value, so the table is
 * total. Listings and ads are unscored sections, so theirs is 0.
 *
 * Pure, and only `.ts` value imports: scripts/prospecting/backfill-r0b.ts
 * runs the scorers under `node --experimental-strip-types`.
 */
export const DEDUCTIONS: Record<ProspectFindingCode, number> = {
  // business_details
  no_website: 50,
  no_https: 20,
  // gbp
  gbp_unclaimed: 50,
  gbp_no_hours: 35,
  gbp_no_phone: 35,
  gbp_no_photos: 30,
  gbp_no_description: 10,
  // reputation
  no_reviews: 100,
  low_rating: 50,
  rating_under_4_8: 10,
  few_reviews: 40,
  reviews_under_50: 15,
  // listings, ads (unscored)
  listing_missing: 0,
  no_ads_running: 0,
  // website_performance
  slow_mobile: 70,
  lcp_needs_improvement: 30,
  no_mobile_viewport: 20,
  // tech_stack
  no_analytics: 40,
  // ai_readiness
  ai_crawlers_blocked: 60,
  no_local_business_schema: 30,
  // ai_presence
  not_in_ai_answers: 100,
  ai_mentions_partial: 50,
  // lead_capture
  no_whatsapp_cta: 20,
  no_booking: 20,
  no_contact_form: 20,
  no_phone_link: 20,
  no_chat_widget: 20,
};

const REVIEWS_CTA = "Want a steady flow of Google reviews?";
const RATING_CTA = "Want to lift your Google rating?";
const PROFILE_CTA = "Want a complete Google Business Profile?";
const SPEED_CTA = "Want a website that loads fast on a phone?";

/** What each finding costs the business, and the call to action it leads to. */
export const FINDING_COPY: Record<ProspectFindingCode, { impact: string; cta: string }> = {
  no_website: {
    impact: "Customers who search online find only the Google listing, and many choose a business with a website instead.",
    cta: "Want a website that turns searches into calls?",
  },
  no_https: {
    impact: "Browsers warn visitors that the site is not secure, and many leave before they read a word.",
    cta: "Want your website to show as secure?",
  },
  not_in_ai_answers: {
    impact: "People who ask AI for a recommendation are sent to other businesses.",
    cta: "Want AI assistants to recommend your business?",
  },
  ai_mentions_partial: {
    impact: "People who ask AI for a recommendation are often sent to other businesses.",
    cta: "Want AI assistants to recommend your business every time?",
  },
  gbp_unclaimed: {
    impact: "Anyone can suggest changes to an unclaimed profile, and you cannot reply to reviews or fix your details.",
    cta: "Want to take control of your Google profile?",
  },
  slow_mobile: {
    impact: "Most visitors on a phone leave before a page this slow appears.",
    cta: SPEED_CTA,
  },
  lcp_needs_improvement: {
    impact: "Some visitors on a phone leave before the page has finished loading.",
    cta: SPEED_CTA,
  },
  no_mobile_viewport: {
    impact: "On a phone the site shows as a shrunken desktop page that visitors have to pinch and zoom.",
    cta: "Want a website that works on a phone?",
  },
  ai_crawlers_blocked: {
    impact: "AI assistants cannot read the website, so they cannot recommend the business.",
    cta: "Want AI assistants to be able to read your website?",
  },
  no_whatsapp_cta: {
    impact: "Customers who prefer WhatsApp have no one-tap way to message you, so they message someone else.",
    cta: "Want customers to reach you on WhatsApp in one tap?",
  },
  no_reviews: {
    impact: "With no reviews, people searching have no reason to trust you over a business that has them.",
    cta: REVIEWS_CTA,
  },
  few_reviews: {
    impact: "A handful of reviews looks thin next to competitors with dozens.",
    cta: REVIEWS_CTA,
  },
  reviews_under_50: {
    impact: "Competitors with more reviews look like the safer choice.",
    cta: REVIEWS_CTA,
  },
  low_rating: {
    impact: "Many people skip a business rated under 4 stars without reading a single review.",
    cta: RATING_CTA,
  },
  rating_under_4_8: {
    impact: "Customers compare ratings, and businesses rated 4.8 or higher win the close calls.",
    cta: RATING_CTA,
  },
  no_contact_form: {
    impact: "Visitors who would rather not call have no way to send an enquiry, so it goes elsewhere.",
    cta: "Want to capture enquiries from your website?",
  },
  no_phone_link: {
    impact: "Visitors on a phone have to copy the number by hand, and some will not bother.",
    cta: "Want visitors to call you in one tap?",
  },
  gbp_no_phone: {
    impact: "People who find you on Google cannot call you from the listing.",
    cta: PROFILE_CTA,
  },
  gbp_no_hours: {
    impact: "People cannot tell whether you are open, so they call a business that says it is.",
    cta: PROFILE_CTA,
  },
  gbp_no_photos: {
    impact: "Profiles without photos get fewer clicks and calls than profiles with them.",
    cta: PROFILE_CTA,
  },
  gbp_no_description: {
    impact: "The profile does not tell people what you do or why to choose you.",
    cta: PROFILE_CTA,
  },
  no_booking: {
    impact: "Customers who want to book after hours cannot, so they book with someone who lets them.",
    cta: "Want customers to book online, day or night?",
  },
  listing_missing: {
    impact: "Customers who look you up in directories do not find you.",
    cta: "Want your business listed where customers look?",
  },
  no_local_business_schema: {
    impact: "Search engines and AI assistants have to guess what the business is and where it works.",
    cta: "Want search engines and AI to understand your business?",
  },
  no_chat_widget: {
    impact: "Visitors with a quick question have no way to ask it while they are on the site.",
    cta: "Want to answer visitors while they are on your site?",
  },
  no_analytics: {
    impact: "You cannot see how many people visit the site or which pages bring in enquiries.",
    cta: "Want to know what your website brings in?",
  },
  no_ads_running: {
    impact: "Competitors who advertise appear above you in search results.",
    cta: "Want to show up first when customers search?",
  },
};

/** A finding with its stored copy. Every scorer builds its findings here. */
export function finding(code: ProspectFindingCode, text: string): ProspectFinding {
  return { code, text, ...FINDING_COPY[code] };
}

/** 100 minus the findings' deductions, floored at 0. */
export function scoreOf(findings: ProspectFinding[]): number {
  return Math.max(0, 100 - findings.reduce((sum, f) => sum + DEDUCTIONS[f.code], 0));
}
