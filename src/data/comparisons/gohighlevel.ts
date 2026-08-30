import type { Comparison } from "@/types/comparisons";

/**
 * GoHighLevel vs LeadStack — the flagship comparison page.
 *
 * GHL is the direct rival LeadStack is positioned head-to-head against, so
 * this page sees the highest converting search intent. Update pricing +
 * verification date when GHL changes their public tiers.
 *
 * Underlying-stack identifiers (Firebase, Twilio, Vapi, Resend, OpenRouter,
 * Vercel, Next.js, gitpage.site, specific AI model names, etc.) are
 * deliberately kept out of this file. Visitors shouldn't be able to
 * reconstruct LeadStack's architecture from the comparison page — that
 * information ships inside the repo they get after purchase.
 */
export const gohighlevelComparison: Comparison = {
  slug: "gohighlevel",
  competitorName: "GoHighLevel",
  competitorShortName: "GHL",
  metaTitle: "GoHighLevel vs LeadStack | All-in-One CRM Compared (2026)",
  metaDescription:
    "GoHighLevel vs LeadStack — feature, pricing, and ownership comparison. Why agencies are switching from $297/mo recurring to a self-hosted all-in-one CRM they own outright.",
  lastVerifiedDate: "August 2026",

  hero: {
    h1: "GoHighLevel vs LeadStack",
    subhead:
      "Both are all-in-one CRMs built for agencies. Only one of them lets you own the code, set your own prices, keep your client data on your own infrastructure, and walk away the day you decide to switch tools.",
    ctaLabel: "See LeadStack pricing",
  },

  pullQuote: {
    text: "GoHighLevel made the modern agency stack possible — one tool, one bill, every channel. LeadStack is the next step: the same surface area, but you own the code, the data, and the margin instead of renting them.",
    author: "The LeadStack team",
    role: "On why LeadStack exists",
  },

  painPoints: {
    heading: "Where GoHighLevel falls short",
    bullets: [
      {
        title: "$297 every month — for as long as you operate",
        body: "GoHighLevel's Unlimited tier is $297 per month, billed in perpetuity. There's no point at which you finish paying. Five years in, you've handed them roughly $17,800 and still don't own a single line of the platform you sell to your clients. The day you stop paying, the tool stops working.",
      },
      {
        title: "White-label is paint, not foundation",
        body: "GHL's white-label is real and well-executed — but it stops at the surface. You can change colors, logos, the login URL, the domain. You cannot change how the platform behaves, ship a feature your client asked for last Tuesday, or fork the codebase when GHL's product direction diverges from yours. Their roadmap is your roadmap.",
      },
      {
        title: "Their database holds your clients hostage",
        body: "Every contact, deal, conversation, and recorded call lives on GoHighLevel's infrastructure. Exporting is possible but partial — webhook history, recorded voice calls, attachment metadata, and automation execution logs are difficult to recover in usable shape. If GHL changes pricing, deprecates a feature, or you simply outgrow them, migration is a months-long project.",
      },
    ],
  },

  advantages: [
    {
      title: "You own the code, not a seat",
      body: "LeadStack is the full source code of an agency CRM you clone, deploy to your own cloud account, and brand as your own product. Every file — the UI, the API routes, the AI agent logic, the booking pages, the quote generator — is yours to read, modify, and extend. There is no platform behind LeadStack waiting to deprecate the feature you depend on.",
    },
    {
      title: "Pricing is a line on a vendor invoice, not a subscription",
      body: "After the one-time license, your only ongoing costs are the actual infrastructure your deployment consumes — cloud hosting, database storage, per-SMS, per-email, per-token AI. You pay your service providers directly at their published rates, with no platform markup baked into repackaged credits. Most agencies' total infrastructure spend is under $50/month for the first dozen sub-accounts.",
    },
    {
      title: "AI built on an open gateway — pick any model",
      body: "Web Chat, SMS auto-reply, and Voice agents all flow through a single AI gateway, configured per channel. One key routes turns to a fast default model, or you can override per channel to a heavier reasoning model from any of the major model families. When a better model ships, you switch with a config change — not a vendor partnership negotiation.",
    },
    {
      title: "White-label all the way down to the database",
      body: "Per-sub-account dedicated phone numbers. Per-sub-account verified email sending domains. Per-sub-account branding, API keys, webhook subscriptions, and a fully tenancy-scoped database so a leaked credential only ever sees one client's data. Every URL, every email, every SMS, every API request can come from the brand your client sees — because the data model was designed that way from line one.",
    },
  ],

  featureTable: {
    heading: "How LeadStack's base license compares to GoHighLevel's base plan",
    rows: [
      // ── Ownership & economics ───────────────────────────────────────────
      {
        category: "Ownership & economics",
        label: "Recurring monthly platform fee",
        leadstack: "$0",
        competitor: "$297/month",
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
        label: "Unlimited sub-accounts",
        leadstack: true,
        competitor: "$297 plan",
      },
      {
        category: "Ownership & economics",
        label: "Snapshots — reusable sub-account config templates",
        footnote:
          "Capture a proven sub-account setup (forms, message templates, products, workflows) and apply it to any other sub-account in one click.",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Ownership & economics",
        label: "Client billing / SaaS mode — sell sub-accounts as monthly plans",
        footnote:
          "Package features into monthly or annual plans and charge each client through your own Stripe account — checkout links, automatic feature unlocks on payment, dunning grace + paywall, per-client special pricing, and one-time charges. GoHighLevel gates SaaS Mode to its $497/mo Agency Pro plan.",
        leadstack: "Included",
        competitor: "$497/mo plan",
      },
      {
        category: "Ownership & economics",
        label: "Per-client usage caps + overage rates — rebill usage at your prices",
        footnote:
          "Set each plan's included monthly usage (emails, SMS segments, WhatsApp, AI tokens, voice minutes) and your own per-unit overage rate. Caps enforce automatically — one heavy client can never drain the shared credits — and usage beyond the allowance accrues in dollars, ready to invoice in one click. GoHighLevel's usage rebilling is part of SaaS Mode on the $497/mo plan.",
        leadstack: "Included",
        competitor: "$497/mo plan",
      },
      {
        category: "Ownership & economics",
        label: "White-label every client surface (login, domain, emails, booking, chat)",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Ownership & economics",
        label: "Premium support",
        leadstack: true,
        competitor: "$500/month",
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
        footnote:
          "Meta Pixel loads site-wide (including hosted form pages) and form submissions automatically fire a Pixel Lead event. GTM covers any other tracker (LinkedIn Insight, TikTok Pixel, Hotjar).",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Lead capture & sites",
        label: "Funnel / landing page / website builder",
        leadstack: true,
        competitor: true,
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
        competitor: true,
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
        label: "Per-sub-account dedicated email sending domain",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Conversations & messaging",
        label: "Dedicated per-client phone number (SMS)",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Conversations & messaging",
        label: "Missed-call text-back (auto-SMS a missed caller) (Beta)",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Conversations & messaging",
        label: "WhatsApp messaging",
        leadstack: true,
        competitor: true,
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
        competitor: true,
      },

      // ── AI ──────────────────────────────────────────────────────────────
      {
        category: "AI",
        label: "AI Web Chat widget",
        leadstack: "Included",
        competitor: "$97/mo add-on",
      },
      {
        category: "AI",
        label: "AI SMS auto-reply",
        leadstack: "Included",
        competitor: "$97/mo add-on",
      },
      {
        category: "AI",
        label: "AI inbound Voice agent",
        leadstack: "Included",
        competitor: "Add-on",
      },
      {
        category: "AI",
        label: "AI outbound Voice — click-to-call + bulk campaigns",
        leadstack: "Included",
        competitor: "Add-on",
      },
      {
        category: "AI",
        label: "AI voice agent books real appointments live on the call",
        footnote:
          "During an inbound call the voice agent checks live availability on a chosen booking page, offers real times, and books the caller in — the appointment lands on the calendar like any other booking, with a follow-up task for the team.",
        leadstack: "Included",
        competitor: "Add-on",
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
        competitor: false,
      },

      // ── Marketing & engagement ──────────────────────────────────────────
      {
        category: "Marketing & engagement",
        label: "Workflow automations",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Marketing & engagement",
        label: "No-reply follow-up sequences (wait-for-reply branching)",
        footnote:
          "Workflows can wait for a contact's reply and branch either way — replied vs. went quiet. Build \"no reply in 2 days → nudge → still silent → task for a human\" flows across SMS, WhatsApp, and Facebook/Instagram, with re-enrollment rules so nobody gets double-messaged. Ships as a ready-made template.",
        leadstack: true,
        competitor: true,
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
        competitor: true,
      },
      {
        category: "Marketing & engagement",
        label: "Google review requests (SMS + WhatsApp, auto + on-demand)",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Marketing & engagement",
        label: "Memberships / courses",
        leadstack: true,
        competitor: true,
      },
      {
        category: "Marketing & engagement",
        label: "Communities",
        leadstack: true,
        competitor: true,
      },

      // ── Platform & developer ────────────────────────────────────────────
      {
        category: "Platform & developer",
        label: "Public REST API (idempotency, versioning)",
        leadstack: "Included",
        competitor: "Higher tier",
      },
      {
        category: "Platform & developer",
        label: "Signed outbound webhooks",
        leadstack: "Included",
        competitor: "Higher tier",
      },
      {
        category: "Platform & developer",
        label: "Per-client API keys + rate limits",
        leadstack: true,
        competitor: "Partial",
      },
      {
        category: "Platform & developer",
        label: "Installable mobile app + push notifications",
        footnote:
          "The dashboard installs to a phone's home screen under YOUR brand, with push notifications for a new lead, an inbound message, a new booking, a missed call, and a quote being accepted or declined. GoHighLevel's white-label mobile app is a paid add-on.",
        leadstack: "Included",
        competitor: "Paid add-on",
      },
      {
        category: "Platform & developer",
        label: "One-click migration import from GoHighLevel",
        footnote:
          "Imports your contacts (with custom fields + tags), opportunities/deals with configurable pipeline-stage mapping, and notes.",
        leadstack: true,
        competitor: false,
      },
    ],
  },

  pricing: {
    heading: "Pricing compared honestly",
    leadstack: {
      headline: "One-time license + your real vendor costs",
      detail:
        "Pay for LeadStack once. The features GoHighLevel sells as paid add-ons — AI Employee, premium support — and capabilities it gates behind higher tiers — the full public API + webhooks — are all included with the license. For most agencies, monthly running costs come in under the price of a cup of coffee — the free tiers across the underlying providers are generous.",
      notes: [
        "AI agents (Web Chat + SMS + Voice): $0/month — included with the license (GoHighLevel's AI Employee is a $97/mo-per-sub-account add-on).",
        "Public API + webhooks: $0 — included with the license (GoHighLevel gates these to higher tiers).",
        "Premium support: $0/month — a direct line to the team comes with the license (GoHighLevel charges $500/month).",
        "Hosting, database, and email all run on generous free tiers that comfortably cover a small agency's first dozen sub-accounts.",
        "Typical all-in running cost for a small agency: around the price of a cup of coffee a month.",
        "SMS, email, and AI usage is billed directly by your providers at their published rates — the same usage GoHighLevel bills you for too, just without the platform markup. Apples-to-apples, it's a wash or cheaper.",
        "Per-client usage caps and your own overage rates are built in — when you rebill usage to a client, the markup is yours, not a platform's.",
      ],
    },
    competitor: {
      headline: "$297/month — and the add-ons stack fast",
      detail:
        "GoHighLevel's Unlimited Plan is $297/month or $2,970/year billed annually. The features most agencies actually need — AI Employee on every sub-account, premium support, white-label mobile app — are paid add-ons stacked on top of the base.",
      notes: [
        "12 months of GHL Unlimited base at $297/mo = $3,564.",
        "AI Employee: $97/month per sub-account — add-on, not included in the $297 base. At 10 sub-accounts that's another $970/month.",
        "Premium Support: $500/month flat — account-level add-on, not included in the $297 base.",
        "Public API + webhooks: gated to higher tiers — not on GoHighLevel's entry ($97) plan.",
        "After 5 years the base alone is roughly $17,820 — with no ownership accrual.",
        "Additional charges for other premium features (white-label mobile app, agency pro tools).",
        "SMS and voice credits are billed through GHL at a markup over the underlying provider's published rates.",
      ],
    },
    summary:
      "For a typical agency, break-even versus a single month of GoHighLevel lands inside the first month — not the first year. From month two onward, every dollar is pure savings, and the platform you sell to your clients is yours, not rented. Run the numbers below.",
  },

  // Same GHL public pricing as the notes above: Unlimited $297/mo, AI
  // Employee $97/mo per sub-account, Premium Support $500/mo flat.
  // Defaults model a realistic established agency (11 clients, AI on all,
  // Premium on) — at those inputs the monthly GHL bill is $1,864, which
  // crosses the license price so the payback line opens at "1 month".
  calculator: {
    heading: "Build your scenario — what does your agency actually need?",
    intro:
      "Plug in your sub-account count, how many of those clients you'd enable AI on, and whether you'd pay for Premium Support. Savings recalculate live, anchored on GoHighLevel's published list prices.",
    competitorTitle: "GoHighLevel",
    unit: {
      sliderLabel: "Sub-accounts (clients you serve)",
      min: 1,
      max: 20,
      defaultValue: 11,
    },
    base: {
      label: "GHL Unlimited",
      monthly: 297,
      per: "flat",
    },
    addon: {
      sliderLabel: "…with GHL AI Employee enabled",
      lineLabel: "AI Employee",
      monthlyPerUnit: 97,
      defaultValue: 11,
      clampToUnit: true,
      hint: "Per sub-account, every month",
      leadstack: {
        label: "Per-client AI add-on",
        hint: "Pay the AI gateway direct (~$0.01/chat)",
      },
    },
    toggle: {
      label: "GHL Premium Support",
      description: "Account-level, flat $500/mo. Toggle on if you'd buy it.",
      monthly: 500,
      defaultOn: true,
      hint: "Account-level add-on",
      leadstack: {
        label: "Premium Support",
        hint: "Direct support from the team — included",
      },
    },
    paybackNote:
      "in typical agency use (10+ clients on AI, Premium Support included), payback is 1 month or less. Every month after that is straight to your bottom line.",
  },

  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        question: "Is LeadStack a true GoHighLevel replacement?",
        answer:
          "Yes — for the work agencies do every day: contacts, pipeline, calendar, booking pages, quotes, workflow automations with no-reply follow-up sequences, bulk email broadcasts, AI Web Chat + SMS + Voice agents, social post scheduling (Facebook + Instagram), Google review requests, dedicated per-sub-account phone numbers and sending domains, client billing with usage allowances and overage rates, and a full public REST API with webhooks. It's the same surface area you sell today — delivered as code you own.",
      },
      {
        question: "Can I cap and rebill my clients' usage like GoHighLevel's SaaS Mode?",
        answer:
          "Yes. Each billing plan can include a monthly usage allowance — emails, SMS segments, WhatsApp messages, AI tokens, and voice minutes — plus your own per-unit overage rate, with per-client overrides for special deals. Caps enforce themselves: when a client hits a limit, that channel pauses for their workspace until the month resets (you're emailed at 80% and 100%), so one heavy client can never silently drain the credit balances your whole agency runs on. Usage beyond the allowance accrues as a dollar amount at your rates, shown per client, and you invoice it in one click with a secure card-payment link. The rates are yours to set — the margin between what your providers charge you and what you charge your clients is your margin, not a platform's.",
      },
      {
        question: "Can it automatically follow up with leads who don't reply?",
        answer:
          "Yes — this is built into the workflow builder, the same way agencies use it in GoHighLevel. A workflow can send a message, then wait for the contact's reply for a window you choose: if they answer, it continues down the \"replied\" path (or simply stops); if they stay quiet, it takes the \"no reply\" path — a nudge text, a second touch, and finally a task so a human picks up the phone. It works across SMS, WhatsApp, and Facebook/Instagram conversations, respects opt-outs and your sending hours, and re-enrollment rules make sure a chatty contact is never double-enrolled. There's a ready-made \"No-reply Follow-up\" template, so a brand-new sub-account can switch on quiet-lead chasing in about a minute.",
      },
      {
        question: "Can I bring my clients across from GoHighLevel?",
        answer:
          "Yes, on your timeline. Contacts import via CSV and your other records come across through the public REST API. The smooth path most agencies take: onboard new clients straight onto LeadStack, run both side by side, and move existing clients at their natural renewal. No big-bang cutover, no pressure.",
      },
      {
        question: "How does the white-label work?",
        answer:
          "You deploy LeadStack to your own cloud under your own domain and set your brand in one config file — name, logo, tagline, support email, pricing. Every surface your clients touch renders as your brand: the landing page, every dashboard screen, transactional emails, public booking pages, the AI chat widget, and customer-facing quote pages. The LeadStack name never appears. And each sub-account can carry its own sending domain and dedicated phone number, so your clients see fully separate brands right down to the channel.",
      },
      {
        question: "What does it actually cost to run?",
        answer:
          "After the one-time license, a small agency runs on the generous free tiers across hosting, database, and email — around the price of a cup of coffee a month. GoHighLevel is $297/month for the platform alone, forever, before add-ons. The usage you'd pay either way — SMS, email, AI — you pay your providers directly, at their published rates, without a platform markup on top.",
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
    body: "LeadStack gives agencies the full GoHighLevel-style surface area as code they own, on infrastructure they control, with no recurring platform fee on top.",
    primaryCtaLabel: "See LeadStack pricing",
    primaryCtaHref: "/#pricing",
  },
};
