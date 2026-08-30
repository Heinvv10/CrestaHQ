import type { Comparison } from "@/types/comparisons";

/**
 * Vendasta vs LeadStack — fourth comparison page.
 *
 * Vendasta is the closest model competitor after GoHighLevel: a real
 * white-label platform sold to agencies serving local businesses. The
 * honest angle here is NOT "they can't white-label" (they can, well) —
 * it's the rent structure: platform fee + per-seat fees + mandatory
 * onboarding + a 12-month contract on the higher tiers, and above all
 * the wholesale marketplace model, where every product you resell
 * carries a wholesale cost paid to Vendasta forever and your margin
 * depth is set by your subscription tier. You're a franchisee, not an
 * owner.
 *
 * Update pricing + verification date when Vendasta changes their
 * public tiers. Figures verified August 2026: Starter $99/mo,
 * Professional $499/mo, Premium $999/mo; mandatory onboarding
 * ($500–$1,500) on monthly Professional/Premium; those tiers carry a
 * 12-month commitment even when billed monthly; extra seats $30–65/mo;
 * marketplace products carry per-product wholesale costs with
 * tier-dependent discounts (marketed as "up to 65% off retail").
 *
 * Underlying-stack identifiers (Firebase, Twilio, Vapi, Resend,
 * OpenRouter, Vercel, Next.js, gitpage.site, specific AI model names,
 * etc.) are deliberately kept out of this file. Visitors shouldn't be
 * able to reconstruct LeadStack's architecture from the comparison page
 * — that information ships inside the repo they get after purchase.
 */
export const vendastaComparison: Comparison = {
  slug: "vendasta",
  competitorName: "Vendasta",
  metaTitle: "Vendasta vs LeadStack | White-Label CRM Compared (2026)",
  metaDescription:
    "Vendasta vs LeadStack — white-label, pricing, and ownership compared. Why agencies trade platform fees, seat charges, and wholesale cuts for a self-hosted CRM they own outright.",
  lastVerifiedDate: "August 2026",

  hero: {
    h1: "Vendasta vs LeadStack",
    subhead:
      "Vendasta got white-label right — your clients really do see your brand. But underneath, you're still renting: a platform fee, per-seat charges, a mandatory onboarding bill, a 12-month contract, and a wholesale cut of nearly everything you sell. LeadStack gives you the white-label platform as code you own — no meter, no cut, no contract.",
    ctaLabel: "See LeadStack pricing",
  },

  pullQuote: {
    text: "Vendasta makes you a franchisee of their platform — the brand is yours, the business model is theirs. LeadStack hands you the deed: your brand, your prices, your entire margin, on software you own.",
    author: "The LeadStack team",
    role: "On franchising vs owning",
  },

  painPoints: {
    heading: "Where Vendasta falls short",
    bullets: [
      {
        title: "The rent stack: platform fee + seats + onboarding + contract",
        body: "Vendasta's Professional plan is $499/month and Premium is $999/month — before extra seats at $30–65/month each, and a mandatory onboarding fee of $500–$1,500 on monthly billing. Both higher tiers carry a 12-month commitment even when paying month-to-month, so there's no walking away mid-year. Five years on Premium is roughly $60,000 in platform fees alone — with nothing owned at the end of it.",
      },
      {
        title: "A wholesale cut of everything you sell — forever",
        body: "Vendasta's engine is its marketplace: the products you resell to clients — reputation management, social tools, websites, listings — each carry a wholesale cost paid to Vendasta, with your discount depth determined by how expensive a subscription tier you're on. That means Vendasta earns on every client, every month, in perpetuity — and the price of protecting your margin is a bigger platform fee. Your growth is their revenue line.",
      },
      {
        title: "White-label paint on a platform you'll never own",
        body: "The branding is yours; nothing else is. The platform, your client data, your storefront, and the products themselves all live on Vendasta's infrastructure under Vendasta's terms. The tools are largely third-party vendor products you can't modify, the roadmap is theirs, and if the pricing model shifts — as marketplace platforms' pricing regularly does — your entire business absorbs it. Leaving means rebuilding, because none of it comes with you.",
      },
    ],
  },

  advantages: [
    {
      title: "You own the code, not a franchise",
      body: "LeadStack is the full source code of an agency CRM you clone, deploy to your own cloud account, and brand as your own product. Every file — the UI, the API routes, the AI agent logic, the booking pages, the quote generator — is yours to read, modify, and extend. No platform fee, no seat charges, no onboarding bill, no contract, and no wholesale meter running underneath your client roster.",
    },
    {
      title: "Keep 100% of what your clients pay you",
      body: "There is no marketplace taking a cut. The fulfillment surface — CRM, pipelines, booking, quotes, invoices, email, SMS, WhatsApp, social inbox, AI chat, SMS and voice agents, review requests, social scheduling — is first-party code included with the license. When you charge a client $500/month for your platform, the margin between that and your raw infrastructure cost (typically a few dollars) is entirely yours.",
    },
    {
      title: "One codebase, one contact record — not a catalog of vendors",
      body: "Vendasta's breadth comes from stitching third-party vendor products behind one login. LeadStack's breadth is native: every feature writes to the same contact timeline, every channel lands in the same inbox, and every workflow can reach every feature — because it's one codebase, not a marketplace. No per-product wholesale SKUs, no per-product data silos.",
    },
    {
      title: "White-label all the way down to the database",
      body: "Per-sub-account dedicated phone numbers, verified email sending domains, branding, API keys, and webhook subscriptions, on a fully tenancy-scoped database you host yourself. Every URL, every email, every SMS, every API request can carry the brand your client sees — and the infrastructure underneath is in your cloud account, not a platform's.",
    },
  ],

  featureTable: {
    heading: "How LeadStack's base license compares to Vendasta's partner plans",
    rows: [
      // ── Ownership & economics ───────────────────────────────────────────
      {
        category: "Ownership & economics",
        label: "Recurring monthly platform fee",
        leadstack: "$0",
        competitor: "$99–999/mo",
      },
      {
        category: "Ownership & economics",
        label: "Mandatory onboarding fee",
        footnote:
          "Vendasta requires a $500–$1,500 onboarding purchase on monthly Professional and Premium plans.",
        leadstack: "$0",
        competitor: "$500–1,500",
      },
      {
        category: "Ownership & economics",
        label: "Per-seat charges for your team",
        leadstack: "$0 — unlimited",
        competitor: "$30–65/seat/mo",
      },
      {
        category: "Ownership & economics",
        label: "No long-term contract",
        footnote:
          "Vendasta's Professional and Premium plans carry a 12-month commitment even when billed monthly. LeadStack is a one-time purchase — there is no contract to be in.",
        leadstack: true,
        competitor: "12-mo commitment",
      },
      {
        category: "Ownership & economics",
        label: "Keep 100% of client revenue — no platform cut or wholesale costs",
        footnote:
          "Vendasta's marketplace products each carry a wholesale cost paid to Vendasta, with discount depth tied to your subscription tier. LeadStack's features are included code — there is nothing to buy wholesale.",
        leadstack: true,
        competitor: false,
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
        leadstack: true,
        competitor: true,
      },
      {
        category: "Ownership & economics",
        label: "Client billing — sell workspaces as monthly plans through your own payment account",
        leadstack: "Included",
        competitor: true,
      },
      {
        category: "Ownership & economics",
        label: "Per-client usage caps + overage rates — rebill usage at your prices",
        footnote:
          "Set each plan's included monthly usage (emails, SMS segments, WhatsApp, AI tokens, voice minutes) and your own per-unit overage rate. Caps enforce automatically and overage accrues in dollars, ready to invoice in one click.",
        leadstack: "Included",
        competitor: false,
      },
      {
        category: "Ownership & economics",
        label: "White-label every client surface (login, domain, emails, booking, chat)",
        leadstack: true,
        competitor: true,
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
        label: "Calendar + meeting scheduling",
        leadstack: true,
        competitor: true,
      },
      {
        category: "CRM & sales",
        label: "Quotes / estimates — accept, decline, PDF",
        leadstack: true,
        competitor: "Proposals",
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
        competitor: "Partial",
      },
      {
        category: "Lead capture & sites",
        label: "Marketing attribution capture (UTM + ad click IDs)",
        leadstack: true,
        competitor: false,
      },
      {
        category: "Lead capture & sites",
        label: "Funnel / landing page / website builder",
        leadstack: true,
        competitor: "Wholesale add-on",
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
        competitor: "Partial",
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
        leadstack: true,
        competitor: "Partial",
      },
      {
        category: "Conversations & messaging",
        label: "Dedicated per-client phone number (SMS)",
        leadstack: true,
        competitor: "Add-on",
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
        competitor: false,
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
        competitor: "Usage-billed",
      },
      {
        category: "AI",
        label: "AI SMS auto-reply",
        leadstack: "Included",
        competitor: "Usage-billed",
      },
      {
        category: "AI",
        label: "AI inbound Voice agent",
        leadstack: "Included",
        competitor: "Usage-billed",
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
        competitor: "Usage-billed",
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
        competitor: "Wholesale add-on",
      },
      {
        category: "Marketing & engagement",
        label: "Google review requests (SMS + WhatsApp, auto + on-demand)",
        leadstack: true,
        competitor: "Wholesale add-on",
      },
      {
        category: "Marketing & engagement",
        label: "Memberships / courses",
        leadstack: true,
        competitor: false,
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
        competitor: "Partner API",
      },
      {
        category: "Platform & developer",
        label: "Signed outbound webhooks",
        leadstack: "Included",
        competitor: "Partial",
      },
      {
        category: "Platform & developer",
        label: "Per-client API keys + rate limits",
        leadstack: true,
        competitor: false,
      },
      {
        category: "Platform & developer",
        label: "Installable mobile app + push notifications — under YOUR brand",
        footnote:
          "The dashboard installs to a phone's home screen under your brand, with push notifications for a new lead, an inbound message, a new booking, a missed call, and a quote being accepted or declined.",
        leadstack: "Included",
        competitor: "Partial",
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
        "Pay for LeadStack once. No platform fee, no seat charges, no onboarding bill, no contract — and critically, no wholesale layer: the fulfillment tools you'd buy as marketplace SKUs on Vendasta are first-party features included with the license. Your only ongoing costs are the infrastructure your deployment actually consumes, paid directly to your providers at their published rates.",
      notes: [
        "Unlimited team seats and unlimited client sub-accounts: $0 — there is no per-user or per-workspace platform charge.",
        "No wholesale costs: review requests, social scheduling, booking, invoicing, AI chat/SMS/voice agents are included code, not resold products.",
        "When you charge a client $500/month, all $500 is yours — LeadStack takes no cut of your client revenue, ever.",
        "Onboarding: $0 — setup is a guided, one-time process with an AI coding assistant able to walk you through every step.",
        "Hosting, database, and email all run on generous free tiers that comfortably cover a small agency's first dozen sub-accounts.",
        "Typical all-in running cost for a small agency: around the price of a cup of coffee a month.",
        "SMS, email, and AI usage is billed directly by your providers at their published rates — and per-client caps + your own overage rates let you rebill it at your margin.",
      ],
    },
    competitor: {
      headline: "$99–999/month + seats + onboarding + a cut of every sale",
      detail:
        "Vendasta's Starter plan is $99/month, Professional $499/month, and Premium $999/month — with extra seats at $30–65/month, a mandatory $500–$1,500 onboarding purchase on monthly Professional/Premium, and a 12-month commitment on those tiers even when billed monthly. Then the real engine kicks in: every marketplace product you resell carries a wholesale cost paid to Vendasta, with your discount depth tied to your subscription tier.",
      notes: [
        "12 months of Premium: $11,988 — plus onboarding in year one, plus seats, plus wholesale product costs.",
        "Extra seats: $30–65/month each, on every plan.",
        "Marketplace wholesale: every product resold to a client (reputation, social, listings, websites) carries a recurring wholesale cost — Vendasta earns on each of your clients, every month.",
        "Deeper wholesale discounts (marketed as up to 65% off retail) require the more expensive subscription tiers — protecting your margin costs more rent.",
        "Professional and Premium carry a 12-month commitment even on monthly billing — there's no walking away mid-year.",
        "After 5 years on Premium, platform fees alone are roughly $60,000 — with no ownership accrual and a client base that lives on their infrastructure.",
      ],
    },
    summary:
      "Vendasta's model works — for Vendasta: rent on the platform, rent per seat, and a wholesale slice of your client revenue in perpetuity. LeadStack collapses all of it into one purchase. Break-even against a Professional subscription lands within the first months, and from then on both the platform fee and the wholesale cut you're no longer paying become your margin.",
  },

  // Same Vendasta public pricing as the notes above: Professional
  // $499/mo (Premium $999/mo — the toggle adds the $500 difference),
  // extra seats from $30/mo each (we model the LOW end of the published
  // $30–65 range), and onboarding from $500 on monthly Professional/
  // Premium. The wholesale cut on resold marketplace products has no
  // published flat price, so it's deliberately left out — the modelled
  // bill is the floor.
  calculator: {
    heading: "Build your scenario — what does the Vendasta stack rent for?",
    intro:
      "Set your seat count and tier. One cost this calculator can't capture: the recurring wholesale fee on every marketplace product you resell — that lands on top of everything below, on every client, every month.",
    competitorTitle: "Vendasta",
    base: {
      label: "Professional plan",
      monthly: 499,
      per: "flat",
      hint: "Platform subscription — 12-month commitment",
      leadstackHint: "No contract, no platform rent",
    },
    addon: {
      sliderLabel: "Extra team seats",
      lineLabel: "Extra seats",
      monthlyPerUnit: 30,
      defaultValue: 2,
      max: 10,
      hint: "From $30/mo each — up to $65 on some plans",
      leadstack: {
        label: "Team seats",
        hint: "Unlimited — no per-seat charge",
      },
    },
    toggle: {
      label: "Premium tier instead",
      description:
        "Upgrade Professional ($499/mo) to Premium ($999/mo) for deeper wholesale discounts.",
      monthly: 500,
      defaultOn: false,
      hint: "Professional → Premium",
      leadstack: {
        label: "Tier upgrades",
        hint: "One license includes everything",
      },
    },
    oneTime: {
      label: "Onboarding",
      amount: 500,
      per: "flat",
      hint: "From $500 — mandatory on monthly Professional/Premium",
      leadstack: {
        label: "Onboarding",
        hint: "Guided setup included",
      },
    },
    paybackNote:
      "against the Professional subscription alone, payback lands inside the first two months — before counting seats, onboarding, or the wholesale cut on every product you resell.",
  },

  competitorWins: {
    heading: "Where Vendasta genuinely wins",
    bullets: [
      "Outsourced fulfillment — Vendasta's marketplace includes white-label fulfillment services, so an agency can sell SEO or content work and have Vendasta's teams deliver it. LeadStack gives you the tools; the service delivery is yours.",
      "The Snapshot Report — their automated marketing-needs assessment is a genuinely effective prospecting tool for opening local-business conversations.",
      "Marketplace breadth — 250+ third-party products under one login covers niches (listings sync, directory management) that a single codebase doesn't try to.",
      "A mature partner ecosystem — training, conferences, and a decade of playbooks for the local-business reseller motion.",
      "Turnkey from day one — nothing to deploy; you can be selling the same afternoon you sign up.",
    ],
    closing:
      "If you want a turnkey reseller business where someone else builds, hosts, and even fulfills the products — and you're comfortable paying rent and a revenue share for that — Vendasta is the polished choice. This page is for the agency that would rather own the platform, keep the whole margin, and deliver its own services on tools it controls.",
  },

  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        question: "Is LeadStack a true Vendasta replacement?",
        answer:
          "For the platform itself — the white-label CRM your clients log into, with pipelines, booking, quotes, invoices, unified inbox, email and SMS campaigns, AI chat/SMS/voice agents, review requests, social scheduling, and client billing — yes, and you own it instead of renting it. What LeadStack doesn't replace is Vendasta's outsourced fulfillment marketplace: if your model depends on reselling third-party services that someone else delivers, that's a genuinely different offering. Agencies that deliver their own services lose nothing and keep the entire margin.",
      },
      {
        question: "Vendasta is white-label too — what's actually different?",
        answer:
          "The depth of the ownership. Vendasta white-labels the surface of a platform they own, hosted on their infrastructure, at a monthly fee, with wholesale costs on the products you sell and a 12-month contract on the higher tiers. LeadStack is the source code: you deploy it to your own cloud, your clients' data sits in your own database, there's no platform fee or per-seat charge, no revenue share on anything you sell, and no contract because there's nothing to subscribe to. One is a franchise; the other is a deed.",
      },
      {
        question: "Can I move my clients across from Vendasta?",
        answer:
          "Yes, on your timeline. Contacts export via CSV and import straight in — custom fields and tags included — and other records come across through the public REST API. The common pattern: onboard new clients straight onto your platform, run both side by side, and migrate existing clients as their engagements renew. Since Vendasta's higher tiers carry a 12-month commitment, most agencies time the final cutover to their contract date.",
      },
      {
        question: "How does the white-label work?",
        answer:
          "You deploy LeadStack to your own cloud under your own domain and set your brand in one config file — name, logo, tagline, support email, pricing. Every surface your clients touch renders as your brand: the landing page, every dashboard screen, transactional emails, public booking pages, the AI chat widget, and customer-facing quote pages. The LeadStack name never appears. And each sub-account can carry its own sending domain and dedicated phone number, so your clients see fully separate brands right down to the channel.",
      },
      {
        question: "What does it actually cost to run?",
        answer:
          "After the one-time license, a small agency runs on the generous free tiers across hosting, database, and email — around the price of a cup of coffee a month. There are no seats, no onboarding fee, and no wholesale costs: the features Vendasta sells as marketplace SKUs are included code. The usage you'd pay either way — SMS, email, AI — you pay your providers directly at their published rates, and per-client caps with your own overage rates let you rebill it at your margin.",
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
    body: "LeadStack gives agencies the white-label platform as code they own, on infrastructure they control — no platform fee, no seat charges, no wholesale cut, no contract.",
    primaryCtaLabel: "See LeadStack pricing",
    primaryCtaHref: "/#pricing",
  },
};
