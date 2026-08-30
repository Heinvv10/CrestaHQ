import type { Comparison } from "@/types/comparisons";

/**
 * HubSpot vs LeadStack — second comparison page.
 *
 * HubSpot is the biggest brand in the space and the other name LeadStack
 * is explicitly positioned against. The angle here differs from the GHL
 * page: HubSpot isn't an agency platform at all — agencies in HubSpot's
 * world are Solutions Partners referring clients who each buy their own
 * portal directly from HubSpot. So the wedge is (1) ownership economics
 * vs seat + contact pricing that compounds per client, and (2) an actual
 * multi-tenant white-label model vs none.
 *
 * Update pricing + verification date when HubSpot changes their public
 * tiers. Figures verified August 2026: Marketing Hub Professional
 * $800/mo annual ($890 month-to-month, 3 seats, 2,000 marketing
 * contacts, $3,000 mandatory onboarding, $45/mo per extra seat);
 * Enterprise $3,600/mo (5 seats, 10,000 marketing contacts, $7,000
 * onboarding, $75/mo per extra seat); ~$250/mo per additional 5,000
 * marketing contacts.
 *
 * Underlying-stack identifiers (Firebase, Twilio, Vapi, Resend,
 * OpenRouter, Vercel, Next.js, gitpage.site, specific AI model names,
 * etc.) are deliberately kept out of this file. Visitors shouldn't be
 * able to reconstruct LeadStack's architecture from the comparison page
 * — that information ships inside the repo they get after purchase.
 */
export const hubspotComparison: Comparison = {
  slug: "hubspot",
  competitorName: "HubSpot",
  metaTitle: "HubSpot vs LeadStack | Agency CRM Compared (2026)",
  metaDescription:
    "HubSpot vs LeadStack — pricing, white-label, and ownership compared. Why agencies skip $800+/mo per-client portals for a self-hosted CRM they own outright and resell under their own brand.",
  lastVerifiedDate: "August 2026",

  hero: {
    h1: "HubSpot vs LeadStack",
    subhead:
      "HubSpot is a great CRM for a company running its own marketing. But if you're an agency, HubSpot's model makes you a referral channel: your clients buy their own portals, see HubSpot's brand, and pay HubSpot's seat-and-contact pricing forever. LeadStack flips that — you own the platform and sell it as yours.",
    ctaLabel: "See LeadStack pricing",
  },

  pullQuote: {
    text: "With HubSpot, the best an agency can be is a partner in someone else's business. With LeadStack, the software is your business — your brand, your prices, your margin, your asset.",
    author: "The LeadStack team",
    role: "On the difference between reselling and owning",
  },

  painPoints: {
    heading: "Where HubSpot falls short for agencies",
    bullets: [
      {
        title: "Per-seat, per-contact pricing that compounds — per client",
        body: "Marketing Hub Professional starts at $800/month billed annually — plus a mandatory $3,000 onboarding fee, $45/month for each seat beyond three, and roughly $250/month for every extra 5,000 marketing contacts. Enterprise is $3,600/month with $7,000 onboarding. Now multiply by every client you serve, because each one needs their own subscription. Ten clients on Professional is roughly $96,000 a year flowing to HubSpot — none of it building anything you own.",
      },
      {
        title: "There is no white-label — you're a sales channel",
        body: "HubSpot's agency motion is the Solutions Partner program: you refer or manage clients who buy HubSpot directly, log into HubSpot, and see HubSpot's brand on every screen and every email footer. You earn a commission; HubSpot earns the customer. When a client asks who makes the software, the answer is never you — and the brand equity from every campaign you run accrues to HubSpot's name, not yours.",
      },
      {
        title: "One portal per client — and none of them are yours",
        body: "HubSpot has no multi-tenant agency model. Every client is a separate portal with its own billing, its own seat count, and its own contact tiers, all living in HubSpot's cloud under HubSpot's terms. There's no central place you provision, package, price, and bill client workspaces — and no way to take any of it with you if HubSpot's pricing or product direction stops working for you.",
      },
    ],
  },

  advantages: [
    {
      title: "You own the code, not a seat",
      body: "LeadStack is the full source code of an agency CRM you clone, deploy to your own cloud account, and brand as your own product. Every file — the UI, the API routes, the AI agent logic, the booking pages, the quote generator — is yours to read, modify, and extend. No seat licenses, no contact tiers, no onboarding fees, no platform behind it waiting to reprice you.",
    },
    {
      title: "Multi-tenant from line one — built to be resold",
      body: "Unlimited client sub-accounts under one roof, each an isolated workspace with its own contacts, pipeline, phone number, sending domain, API keys, and branding. Package features into monthly plans, charge each client through your own payment account, and gate features per plan — the SaaS-mode economics HubSpot simply doesn't offer, because in HubSpot's model the SaaS company is HubSpot.",
    },
    {
      title: "Pricing is a line on a vendor invoice, not a subscription",
      body: "After the one-time license, your only ongoing costs are the actual infrastructure your deployment consumes — cloud hosting, database storage, per-SMS, per-email, per-token AI. You pay your service providers directly at their published rates. Most agencies' total infrastructure spend is under $50/month for the first dozen sub-accounts — less than one HubSpot seat.",
    },
    {
      title: "AI built on an open gateway — pick any model",
      body: "Web Chat, SMS auto-reply, and Voice agents all flow through a single AI gateway, configured per channel — no per-credit AI metering sold back to you at a markup. One key routes turns to a fast default model, or you can override per channel to a heavier reasoning model from any of the major model families. When a better model ships, you switch with a config change.",
    },
  ],

  featureTable: {
    heading: "How LeadStack's base license compares to HubSpot's Professional tiers",
    rows: [
      // ── Ownership & economics ───────────────────────────────────────────
      {
        category: "Ownership & economics",
        label: "Recurring monthly platform fee",
        leadstack: "$0",
        competitor: "$800–3,600/mo + seats",
      },
      {
        category: "Ownership & economics",
        label: "Mandatory onboarding fee",
        leadstack: "$0",
        competitor: "$3,000–7,000",
      },
      {
        category: "Ownership & economics",
        label: "Full source code access — modify any feature",
        leadstack: true,
        competitor: false,
      },
      {
        category: "Ownership & economics",
        label: "Self-host on your own cloud account",
        leadstack: true,
        competitor: false,
      },
      {
        category: "Ownership & economics",
        label: "Client data on your own infrastructure",
        leadstack: true,
        competitor: false,
      },
      {
        category: "Ownership & economics",
        label: "Unlimited client sub-accounts under one roof",
        footnote:
          "HubSpot has no multi-tenant agency model — each client is a separate HubSpot portal on its own subscription, seats, and contact tiers.",
        leadstack: true,
        competitor: false,
      },
      {
        category: "Ownership & economics",
        label: "Snapshots — reusable sub-account config templates",
        footnote:
          "Capture a proven sub-account setup (forms, message templates, products, workflows) and apply it to any other sub-account in one click.",
        leadstack: true,
        competitor: false,
      },
      {
        category: "Ownership & economics",
        label: "Client billing / SaaS mode — sell workspaces as monthly plans",
        footnote:
          "Package features into monthly or annual plans and charge each client through your own payment account — checkout links, automatic feature unlocks on payment, dunning grace + paywall, per-client special pricing, and one-time charges. HubSpot's agency equivalent is a partner commission on subscriptions your clients buy from HubSpot.",
        leadstack: "Included",
        competitor: false,
      },
      {
        category: "Ownership & economics",
        label: "Per-client usage caps + overage rates — rebill usage at your prices",
        footnote:
          "Set each plan's included monthly usage (emails, SMS segments, WhatsApp, AI tokens, voice minutes) and your own per-unit overage rate. Caps enforce automatically and usage beyond the allowance accrues in dollars, ready to invoice in one click.",
        leadstack: "Included",
        competitor: false,
      },
      {
        category: "Ownership & economics",
        label: "White-label every client surface (login, domain, emails, booking, chat)",
        leadstack: true,
        competitor: false,
      },

      // ── CRM & sales ─────────────────────────────────────────────────────
      {
        category: "CRM & sales",
        label: "Contacts — notes, activity timeline, custom fields",
        leadstack: true,
        competitor: true,
      },
      {
        category: "CRM & sales",
        label: "Contact tagging — audiences, filters, tag-triggered workflows",
        leadstack: true,
        competitor: true,
      },
      {
        category: "CRM & sales",
        label: "CSV import + export",
        leadstack: true,
        competitor: true,
      },
      {
        category: "CRM & sales",
        label: "Pipelines / opportunities (drag-and-drop Kanban)",
        leadstack: true,
        competitor: true,
      },
      {
        category: "CRM & sales",
        label: "Tasks",
        leadstack: true,
        competitor: true,
      },
      {
        category: "CRM & sales",
        label: "Calendar",
        leadstack: true,
        competitor: true,
      },
      {
        category: "CRM & sales",
        label: "Quotes / estimates — accept, decline, PDF",
        leadstack: true,
        competitor: true,
      },
      {
        category: "CRM & sales",
        label: "Product catalog",
        leadstack: true,
        competitor: true,
      },
      {
        category: "CRM & sales",
        label: "Invoices — card + PayPal payment links, auto-marked paid on card payment",
        leadstack: true,
        competitor: true,
      },
      {
        category: "CRM & sales",
        label: "Territory / team assignment",
        leadstack: true,
        competitor: true,
      },

      // ── Lead capture & sites ────────────────────────────────────────────
      {
        category: "Lead capture & sites",
        label: "Form builder — hosted pages + iframe embed",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Lead capture & sites",
        label: "Marketing attribution capture (UTM + ad click IDs)",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Lead capture & sites",
        label: "Meta Pixel + Google Tag Manager tracking",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Lead capture & sites",
        label: "Funnel / landing page / website builder",
        leadstack: true,
        competitor: "Pro+ tiers",
      },
      {
        category: "Lead capture & sites",
        label: "Booking pages — reminders + card deposits",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Lead capture & sites",
        label: "Checkout pages — one-off offers with order bumps",
        leadstack: true,
        competitor: "US only",
      },
      {
        category: "Lead capture & sites",
        label: "Leads map (geographic lead view)",
        leadstack: true,
        competitor: false,
      },

      // ── Conversations & messaging ───────────────────────────────────────
      {
        category: "Conversations & messaging",
        label: "Unified inbox across channels",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Conversations & messaging",
        label: "Per-client dedicated email sending domain",
        footnote:
          "In HubSpot a sending domain belongs to a portal — separate client brands mean separate portals, each on its own subscription.",
        leadstack: true,
        competitor: "One per portal",
      },
      {
        category: "Conversations & messaging",
        label: "Dedicated per-client phone number (SMS)",
        leadstack: true,
        competitor: "Add-on (US)",
      },
      {
        category: "Conversations & messaging",
        label: "Missed-call text-back (auto-SMS a missed caller) (Beta)",
        leadstack: true,
        competitor: false,
      },
      {
        category: "Conversations & messaging",
        label: "WhatsApp messaging",
        leadstack: true,
        competitor: "Pro+ tiers",
      },
      {
        category: "Conversations & messaging",
        label: "Facebook Messenger + Instagram DM inbox",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Conversations & messaging",
        label: "Bulk email broadcasts",
        leadstack: true,
        competitor: "Contact-tier priced",
      },

      // ── AI ──────────────────────────────────────────────────────────────
      {
        category: "AI",
        label: "AI Web Chat widget",
        leadstack: "Included",
        competitor: "Credit-metered",
      },
      {
        category: "AI",
        label: "AI SMS auto-reply",
        leadstack: "Included",
        competitor: false,
      },
      {
        category: "AI",
        label: "AI inbound Voice agent",
        leadstack: "Included",
        competitor: false,
      },
      {
        category: "AI",
        label: "AI outbound Voice — click-to-call + bulk campaigns",
        leadstack: "Included",
        competitor: false,
      },
      {
        category: "AI",
        label: "AI voice agent books real appointments live on the call",
        footnote:
          "During an inbound call the voice agent checks live availability on a chosen booking page, offers real times, and books the caller in — the appointment lands on the calendar like any other booking, with a follow-up task for the team.",
        leadstack: "Included",
        competitor: false,
      },
      {
        category: "AI",
        label: "Pick any AI model (open gateway, not locked in)",
        leadstack: true,
        competitor: false,
      },
      {
        category: "AI",
        label: "AI knowledge base from the client's website",
        leadstack: true,
        competitor: true,
      },
      {
        category: "AI",
        label: "AI guardrails — human-approved actions, full audit trail",
        leadstack: true,
        competitor: "Partial",
      },

      // ── Marketing & engagement ──────────────────────────────────────────
      {
        category: "Marketing & engagement",
        label: "Workflow automations",
        leadstack: true,
        competitor: "Pro+ tiers",
      },
      {
        category: "Marketing & engagement",
        label: "No-reply follow-up sequences (wait-for-reply branching)",
        footnote:
          "Workflows can wait for a contact's reply and branch either way — replied vs. went quiet — across SMS, WhatsApp, and Facebook/Instagram, with re-enrollment rules so nobody gets double-messaged. Ships as a ready-made template.",
        leadstack: true,
        competitor: "Partial",
      },
      {
        category: "Marketing & engagement",
        label: "Merge tags / custom values ({{...}}) in email + SMS",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Marketing & engagement",
        label: "Social post scheduling (Facebook + Instagram)",
        leadstack: true,
        competitor: "Pro+ tiers",
      },
      {
        category: "Marketing & engagement",
        label: "Google review requests (SMS + WhatsApp, auto + on-demand)",
        leadstack: true,
        competitor: false,
      },
      {
        category: "Marketing & engagement",
        label: "Memberships / courses",
        leadstack: true,
        competitor: "Separate hub",
      },
      {
        category: "Marketing & engagement",
        label: "Communities",
        leadstack: true,
        competitor: false,
      },

      // ── Platform & developer ────────────────────────────────────────────
      {
        category: "Platform & developer",
        label: "Public REST API (idempotency, versioning)",
        leadstack: "Included",
        competitor: true,
      },
      {
        category: "Platform & developer",
        label: "Signed outbound webhooks",
        leadstack: "Included",
        competitor: true,
      },
      {
        category: "Platform & developer",
        label: "Per-client API keys + rate limits",
        leadstack: true,
        competitor: "One per portal",
      },
      {
        category: "Platform & developer",
        label: "Installable mobile app + push notifications — under YOUR brand",
        footnote:
          "The dashboard installs to a phone's home screen under your brand, with push notifications for a new lead, an inbound message, a new booking, a missed call, and a quote being accepted or declined. HubSpot's mobile app is HubSpot-branded.",
        leadstack: "Included",
        competitor: "HubSpot-branded",
      },
      {
        category: "Platform & developer",
        label: "Bring contacts + deals across (CSV import, open API)",
        leadstack: true,
        competitor: true,
      },
    ],
  },

  pricing: {
    heading: "Pricing compared honestly",
    leadstack: {
      headline: "One-time license + your real vendor costs",
      detail:
        "Pay for LeadStack once. There are no seats to count, no marketing-contact tiers to graduate into, and no onboarding fee. Every client you add is a sub-account in your own deployment — the platform cost of client number twenty is the same as client number one: zero. Your only ongoing costs are the infrastructure your deployment actually consumes, paid directly to your providers at their published rates.",
      notes: [
        "Unlimited seats and unlimited client sub-accounts: $0 — there is no per-user or per-workspace platform charge at all.",
        "Onboarding: $0 — setup is a guided, one-time process with an AI coding assistant able to walk you through every step.",
        "AI agents (Web Chat + SMS + Voice): $0/month — included with the license, no credit packs.",
        "Public API + webhooks: $0 — included with the license.",
        "Hosting, database, and email all run on generous free tiers that comfortably cover a small agency's first dozen sub-accounts.",
        "Typical all-in running cost for a small agency: around the price of a cup of coffee a month.",
        "SMS, email, and AI usage is billed directly by your providers at their published rates — no platform markup.",
        "Per-client usage caps and your own overage rates are built in — when you rebill usage to a client, the markup is yours, not a platform's.",
      ],
    },
    competitor: {
      headline: "$800+/month per client — before seats, contacts, and onboarding",
      detail:
        "Marketing Hub Professional is $800/month billed annually ($890 month-to-month) with 3 seats and 2,000 marketing contacts included, plus a mandatory $3,000 onboarding fee. Enterprise is $3,600/month with $7,000 onboarding. And because HubSpot has no agency multi-tenancy, that pricing applies per client portal, not per agency.",
      notes: [
        "12 months of Marketing Hub Professional: $9,600 billed annually — plus the $3,000 one-time onboarding fee in year one.",
        "Extra seats: $45/month each on Professional, $75/month on Enterprise.",
        "Extra marketing contacts: roughly $250/month for every additional 5,000 beyond the included tier.",
        "Sales Hub and Service Hub are priced separately, per seat, on top of Marketing Hub.",
        "Ten clients on Professional portals: roughly $96,000/year in subscriptions flowing to HubSpot — with your agency earning at most a partner commission.",
        "AI features meter through credit systems on top of the subscription.",
        "After 5 years, one Professional portal alone is roughly $51,000 including onboarding — with no ownership accrual.",
      ],
    },
    summary:
      "For an agency, the comparison isn't close: a single client's first year on HubSpot Professional costs more than the LeadStack license — and LeadStack covers every client you'll ever add. Break-even lands inside the first months, and everything after that is margin on software you own.",
  },

  // Same HubSpot public pricing as the notes above: Marketing Hub
  // Professional $800/mo (billed annually) per client portal with 2,000
  // marketing contacts included, ~$250/mo per extra 5,000 contacts, and
  // a mandatory $3,000 one-time onboarding fee per portal. Because
  // HubSpot has no agency multi-tenancy, every cost is per portal.
  calculator: {
    heading: "Build your scenario — what would your roster cost on HubSpot?",
    intro:
      "Pick how many client portals you'd run and how many of them need extra contact capacity. Savings recalculate live, anchored on HubSpot's published Marketing Hub Professional list prices.",
    competitorTitle: "HubSpot",
    unit: {
      sliderLabel: "Client portals (one per client)",
      min: 1,
      max: 20,
      defaultValue: 5,
    },
    base: {
      label: "Marketing Hub Professional",
      monthly: 800,
      per: "unit",
      hint: "$800/mo per portal, billed annually",
      leadstackHint: "One deployment, unlimited client sub-accounts",
    },
    addon: {
      sliderLabel: "…portals needing +5,000 extra marketing contacts",
      lineLabel: "Extra contacts (+5,000)",
      monthlyPerUnit: 250,
      defaultValue: 2,
      clampToUnit: true,
      hint: "~$250/mo per additional 5,000 contacts",
      leadstack: {
        label: "Contact limits",
        hint: "No contact tiers — unlimited",
      },
    },
    oneTime: {
      label: "Onboarding fee",
      amount: 3000,
      per: "unit",
      hint: "Mandatory, one-time, per portal",
      leadstack: {
        label: "Onboarding",
        hint: "Guided setup included",
      },
    },
    paybackNote:
      "the mandatory onboarding fee on a single portal is more than three times the entire LeadStack license, so payback is immediate at any scale.",
  },

  competitorWins: {
    heading: "Where HubSpot genuinely wins",
    bullets: [
      "Ecosystem breadth — an app marketplace with over a thousand integrations, plus a mature partner and consultant network around the product.",
      "Reporting depth — multi-touch revenue attribution, ABM tooling, and enterprise-grade custom reporting that goes deeper than what most agencies resell to small-business clients.",
      "A genuinely useful free CRM tier for a business dipping a toe in before committing.",
      "Enterprise governance — SSO, sandboxes, granular permission sets, and compliance features built for large in-house teams.",
      "HubSpot Academy — best-in-class free training and certification that makes onboarding new marketing hires easier.",
    ],
    closing:
      "If you're an in-house marketing team at a mid-market company standardizing on one vendor — with a budget that absorbs seat pricing — HubSpot is an excellent choice. This page is for a different buyer: the agency that wants to own the platform it sells to clients, not refer customers into someone else's.",
  },

  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        question: "Is LeadStack a true HubSpot replacement for an agency?",
        answer:
          "For the work agencies actually resell to small-business clients — contacts, pipeline, calendar, booking pages, quotes, workflow automations, bulk email, AI Web Chat + SMS + Voice agents, social post scheduling, review requests, per-client phone numbers and sending domains, and client billing — yes, and it adds the multi-tenant white-label layer HubSpot doesn't have at all. What it doesn't try to replace is HubSpot's enterprise reporting and ABM depth; if your clients are mid-market companies buying multi-touch attribution, that's a different product category.",
      },
      {
        question: "How is this different from being a HubSpot Solutions Partner?",
        answer:
          "A Solutions Partner refers or manages clients who each buy HubSpot directly — the client's contract, data, and brand experience all belong to HubSpot, and the agency earns a commission on someone else's subscription. With LeadStack, you own the software: your clients log into your branded platform, pay you the price you set, and the entire margin between your infrastructure cost and your price is yours. One is a channel relationship; the other is a software business.",
      },
      {
        question: "Can I move my clients across from HubSpot?",
        answer:
          "Yes, on your timeline. Contacts export cleanly from HubSpot via CSV and import straight in — custom fields and tags included — and other records come across through the public REST API. The smooth path most agencies take: onboard new clients straight onto your platform, run both side by side, and move existing clients as their HubSpot renewals come up. No big-bang cutover, no pressure.",
      },
      {
        question: "How does the white-label work?",
        answer:
          "You deploy LeadStack to your own cloud under your own domain and set your brand in one config file — name, logo, tagline, support email, pricing. Every surface your clients touch renders as your brand: the landing page, every dashboard screen, transactional emails, public booking pages, the AI chat widget, and customer-facing quote pages. The LeadStack name never appears. And each sub-account can carry its own sending domain and dedicated phone number, so your clients see fully separate brands right down to the channel.",
      },
      {
        question: "What does it actually cost to run?",
        answer:
          "After the one-time license, a small agency runs on the generous free tiers across hosting, database, and email — around the price of a cup of coffee a month. Compare that to a single HubSpot Professional portal at $800/month plus $3,000 onboarding, multiplied by every client. The usage you'd pay either way — SMS, email, AI — you pay your providers directly, at their published rates, without a platform markup on top.",
      },
      {
        question: "Who owns my client data?",
        answer:
          "You do — completely. Every contact, deal, conversation, and call summary lives in your own cloud project, under your billing and your access control. There's no LeadStack-controlled database in the loop, and you can export everything at any time with your database vendor's standard tools. Your clients' data is your asset, not a vendor's leverage.",
      },
      {
        question: "Do I need to be a developer to run LeadStack?",
        answer:
          "No code, ever — once it's deployed, the entire CRM runs in the browser. Setup is a one-time, guided process: you create a few standard provider accounts and paste in the keys, with an AI coding assistant able to walk you through every step. There's nothing to write — just accounts to connect. Budget around a couple of hours if it's your first time and this isn't something you do every day; faster if it is. After that, it's just your CRM.",
      },
      {
        question: "What if I want to stop using LeadStack one day?",
        answer:
          "You keep everything. It's your code on your infrastructure with your data — so your deployment runs as long as you want it to, with or without us. That's the whole point of owning an asset instead of renting access: a SaaS disappears the day the company does; what you own doesn't.",
      },
    ],
  },

  finalCta: {
    headline: "Own your CRM. Stop renting it.",
    body: "LeadStack gives agencies a full all-in-one CRM as code they own, on infrastructure they control, with a real multi-tenant white-label model — no seats, no contact tiers, no platform fee.",
    primaryCtaLabel: "See LeadStack pricing",
    primaryCtaHref: "/#pricing",
  },
};
