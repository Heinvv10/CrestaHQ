import type { PublicReport } from "@/lib/prospecting/public-report";

/**
 * A made-up public report for the PDF evidence render and the memory
 * measurement (R5). No real business, person or number: the repo is a
 * white-label template.
 */
export const FIXTURE_PUBLIC_REPORT: PublicReport = {
  businessName: "Example Plumbing Co",
  headline: "AI assistants like ChatGPT and Gemini did not name the business in any of 6 answers to local searches for its services.",
  generatedAt: "2026-09-20T08:00:00.000Z",
  agency: { name: "Example Growth Agency", logoUrl: null, appTheme: null, brandColor: "#0F766E" },
  cta: "/b/sa-example/intro-call",
  whatsappNumber: "+27000000000",
  mysteryShop: [],
  sections: [
    {
      key: "ai_presence", status: "ok", score: 0, reason: null, reasonCode: null,
      findings: [{
        code: "not_in_ai_answers",
        text: "AI assistants like ChatGPT and Gemini did not name the business in any of 6 answers to local searches for its services.",
        impact: "People who ask AI for a recommendation are sent to other businesses.",
        cta: "Want AI assistants to recommend your business?",
      }],
      details: {
        mentionedIn: 0, answersMeasured: 6, topCompetitors: "Alpha Pipes, Beta Drains, Gamma Geysers",
        question1: "best plumber in Exampletown", question2: "emergency plumber near Exampletown", question3: "who fixes burst geysers in Exampletown",
      },
    },
    {
      key: "website_performance", status: "ok", score: 30, reason: null, reasonCode: null,
      findings: [{ code: "slow_mobile", text: "The website takes 9.8 seconds to show its main content on a phone.", impact: "Most visitors on a phone leave before a page that slow appears.", cta: null }],
      details: { lcpSeconds: 9.8, mobileViewport: true },
    },
    {
      key: "lead_capture", status: "ok", score: 60, reason: null, reasonCode: null,
      findings: [
        { code: "no_whatsapp_cta", text: "The website has no WhatsApp click-to-chat button.", impact: "Customers who prefer WhatsApp have no quick way to reach you.", cta: null },
        { code: "no_chat_widget", text: "The website has no live chat.", impact: null, cta: null },
      ],
      details: { whatsapp: false, booking: true, contactForm: true, phoneLink: true, chatWidget: false },
    },
    {
      key: "reputation", status: "ok", score: 70, reason: null, reasonCode: null,
      findings: [{ code: "rating_under_4_8", text: "The Google rating is 4.5, below the 4.8 threshold people look for.", impact: "Shoppers comparing options pick the higher-rated business.", cta: null }],
      details: { rating: 4.5, reviewsCount: 33, velocity90d: 4, ownerReplyRate: 0.5 },
    },
    {
      key: "gbp", status: "ok", score: 100, reason: null, reasonCode: null, findings: [],
      details: { description: "Plumbing, geysers and drains in Exampletown.", hoursListed: true, photoCount: 12, phoneListed: true },
    },
    {
      key: "business_details", status: "ok", score: 100, reason: null, reasonCode: null, findings: [],
      details: { name: "Example Plumbing Co", website: "https://example.com", category: "Plumber", https: true },
    },
    {
      key: "listings", status: "timeout", score: null, reason: "The directories did not answer in time.", reasonCode: null,
      findings: [], details: {},
    },
  ],
};
