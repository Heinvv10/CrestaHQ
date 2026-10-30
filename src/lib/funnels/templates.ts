import type {
  FunnelLanding,
  FunnelTemplateKey,
  FunnelThanks,
} from "@/types/funnels";

/**
 * Funnel starter templates.
 *
 * These are PLACEHOLDER COPY, not finished words — the operator edits every
 * field. Their job is to remove the blank-page problem and show what each
 * field is for, the same role the website builder's "Sample" button plays.
 *
 * Deliberately generic across industries: this ships in a white-label product
 * where the buyer's clients could be anyone. No niche assumptions, no
 * fabricated claims or statistics in the defaults — an operator who forgets to
 * edit should end up with something bland, never with something untrue.
 */

export interface FunnelTemplate {
  key: FunnelTemplateKey;
  label: string;
  description: string;
  /** True when this template's whole point is a video. */
  wantsVideo: boolean;
  /** False for lead-gen templates with nothing to sell. */
  wantsCheckout: boolean;
  landing: FunnelLanding;
  thanks: FunnelThanks;
}

export const FUNNEL_TEMPLATES: FunnelTemplate[] = [
  {
    key: "simple_offer",
    label: "Simple offer",
    description:
      "Pitch page straight into checkout. Best for a single product or package.",
    wantsVideo: false,
    wantsCheckout: true,
    landing: {
      headline: "A clear, specific promise goes here",
      subheadline:
        "One or two lines on who this is for and what changes for them.",
      bullets: [
        "What they get, stated plainly",
        "The problem it removes",
        "Why it's worth the price",
      ],
      videoUrl: null,
      imageUrl: null,
      ctaLabel: "Get started",
    },
    thanks: {
      headline: "You're all set",
      body: "Thanks for your purchase — check your email for the details. If anything's missing, just reply to that email.",
      redirectUrl: null,
    },
  },
  {
    key: "vsl",
    label: "Video sales letter",
    description:
      "Video first, one CTA underneath. Everything else stays out of the way.",
    wantsVideo: true,
    wantsCheckout: true,
    landing: {
      headline: "Watch this before you decide",
      subheadline: "A short video explaining exactly how this works.",
      bullets: [
        "What you'll learn in the video",
        "Who it's for",
        "What happens after you buy",
      ],
      videoUrl: null,
      imageUrl: null,
      ctaLabel: "Buy now",
    },
    thanks: {
      headline: "Thank you",
      body: "Your payment went through. Details are on the way to your inbox.",
      redirectUrl: null,
    },
  },
  {
    key: "lead_magnet",
    label: "Lead magnet",
    description:
      "Free offer with no checkout — the CTA points wherever you like (a booking page, a download, a form).",
    wantsVideo: false,
    wantsCheckout: false,
    landing: {
      headline: "Get the free [thing] that helps with [problem]",
      subheadline: "No cost, no obligation — just the useful part.",
      bullets: [
        "What's inside",
        "How long it takes to use",
        "Who it's for",
      ],
      videoUrl: null,
      imageUrl: null,
      ctaLabel: "Send it to me",
    },
    thanks: {
      headline: "On its way",
      body: "Check your inbox in the next few minutes. If it hasn't arrived, look in spam.",
      redirectUrl: null,
    },
  },
];

export function funnelTemplate(key: FunnelTemplateKey): FunnelTemplate {
  return (
    FUNNEL_TEMPLATES.find((t) => t.key === key) ?? FUNNEL_TEMPLATES[0]
  );
}
