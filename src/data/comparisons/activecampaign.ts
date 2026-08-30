import type { Comparison } from "@/types/comparisons";

/**
 * ActiveCampaign vs LeadStack — third comparison page.
 *
 * ActiveCampaign is a best-in-class email automation tool for a single
 * business — not an agency platform. The honest angle here: (1) its
 * contact-tier pricing climbs with every list, per client account;
 * (2) it DOES have an agency reseller program (rare), but per AC's own
 * program docs there's no white-label UI — your clients still use
 * ActiveCampaign's app, so you're reselling someone else's product at a
 * capped margin; (3) it's email-first, so agencies end up stitching
 * SMS, booking, quotes, payments, and social inbox tools around it.
 *
 * Update pricing + verification date when AC changes their public
 * tiers. Figures verified August 2026: four Email/Marketing tiers
 * (Starter / Plus / Professional / Enterprise), contact-tier priced —
 * from $15/mo at 1,000 contacts; at 2,500 contacts $39/$95/$149/$255;
 * at 5,000 $79/$145/$205/$375; at 10,000 $149/$189/$375/$589 (monthly).
 * Monthly send caps of 10× contacts (Starter/Plus), 12× (Pro),
 * 15× (Enterprise). SMS is a credit add-on. Sales CRM/pipelines are an
 * add-on to the marketing plans.
 *
 * Underlying-stack identifiers (Firebase, Twilio, Vapi, Resend,
 * OpenRouter, Vercel, Next.js, gitpage.site, specific AI model names,
 * etc.) are deliberately kept out of this file. Visitors shouldn't be
 * able to reconstruct LeadStack's architecture from the comparison page
 * — that information ships inside the repo they get after purchase.
 */
export const activecampaignComparison: Comparison = {
  slug: "activecampaign",
  competitorName: "ActiveCampaign",
  metaTitle: "ActiveCampaign vs LeadStack | Agency CRM Compared (2026)",
  metaDescription:
    "ActiveCampaign vs LeadStack — pricing, white-label, and scope compared. Why agencies outgrow per-contact email pricing and stitched-together tools for a self-hosted all-in-one CRM they own.",
  lastVerifiedDate: "August 2026",

  hero: {
    h1: "ActiveCampaign vs LeadStack",
    subhead:
      "ActiveCampaign is genuinely great at email automation — for one business, on one list, on a price that climbs with every contact. Run it for clients and you're buying it again for each of them, reselling an app that still says ActiveCampaign on it, and bolting on separate tools for everything email can't do.",
    ctaLabel: "See LeadStack pricing",
  },

  pullQuote: {
    text: "ActiveCampaign charges you by the contact for one channel. LeadStack hands you the whole platform — every channel, every client, one license — and the price never moves when your lists grow.",
    author: "The LeadStack team",
    role: "On per-contact pricing vs ownership",
  },

  painPoints: {
    heading: "Where ActiveCampaign falls short for agencies",
    bullets: [
      {
        title: "Contact-tier pricing that climbs with every list — per client",
        body: "ActiveCampaign is priced by contact count, and the curve is steep: the Professional tier runs $149/month at 2,500 contacts, $375/month at 10,000 — and every plan caps monthly email sends at 10–15× your contact count on top. Each client needs their own account, so a ten-client roster means ten separate subscriptions, each one ratcheting upward as the very lists you're growing for your clients get bigger. Success is literally the thing that raises the bill.",
      },
      {
        title: "A reseller program isn't ownership — and there's no white-label UI",
        body: "Credit where due: ActiveCampaign is one of the few email platforms with an agency reseller program. But by their own program documentation there is no white-label interface — the app your clients log into is ActiveCampaign's, with ActiveCampaign's name on it. You're a distribution channel earning a capped margin on someone else's product, on terms and pricing they can change, for customers who can see exactly which tool you're marking up.",
      },
      {
        title: "Email-first means everything else is another subscription",
        body: "ActiveCampaign's core is email (and it's excellent at it). But agencies sell outcomes, not newsletters — and the rest of the stack is missing or bolted on: SMS is a credit add-on, the sales CRM is an add-on, there's no voice, no native booking pages, no quotes or invoices, no payments, no unified social inbox, no review requests. By the time you've stitched the gaps with third-party tools, you're managing five more subscriptions and none of them share a contact record.",
      },
    ],
  },

  advantages: [
    {
      title: "You own the code, not a contact tier",
      body: "LeadStack is the full source code of an agency CRM you clone, deploy to your own cloud account, and brand as your own product. Every file — the UI, the API routes, the AI agent logic, the booking pages, the quote generator — is yours to read, modify, and extend. Your client lists can grow to any size without a platform re-pricing you, because there is no platform meter running.",
    },
    {
      title: "Every channel in one contact record — not just email",
      body: "Email, SMS, WhatsApp, Facebook Messenger, Instagram DM, web chat, and voice all land in one unified inbox against one contact timeline. Workflows send and branch across all of them — wait for a reply on SMS, nudge on WhatsApp, task a human when a lead goes quiet. The all-in-one surface agencies otherwise assemble from an email tool plus four other subscriptions ships as one codebase.",
    },
    {
      title: "Multi-tenant from line one — built to be resold",
      body: "Unlimited client sub-accounts under one roof, each an isolated workspace with its own contacts, pipeline, phone number, sending domain, API keys, and branding. Package features into monthly plans, charge each client through your own payment account, and set your own usage allowances and overage rates. Your clients see your product at your price — not a discounted seat on someone else's.",
    },
    {
      title: "AI agents that talk to leads, not just draft copy",
      body: "ActiveCampaign's AI helps you write emails and assemble automations. LeadStack's AI answers your clients' actual leads — a web chat widget that captures contact details mid-conversation, SMS auto-replies on the client's own number, and a voice agent that answers inbound calls and books real appointments live on the call. All of it flows through an open AI gateway, so you pick the model and pay the provider directly.",
    },
  ],

  featureTable: {
    heading: "How LeadStack's base license compares to ActiveCampaign's marketing tiers",
    rows: [
      // ── Ownership & economics ───────────────────────────────────────────
      {
        category: "Ownership & economics",
        label: "Recurring monthly platform fee",
        leadstack: "$0",
        competitor: "$15–589+/mo per client",
      },
      {
        category: "Ownership & economics",
        label: "Pricing tied to contact count",
        footnote:
          "ActiveCampaign's tiers are priced by contacts (e.g. Professional: $149/mo at 2,500 contacts, $375/mo at 10,000), with monthly email sends capped at 10–15× the contact limit depending on tier.",
        leadstack: false,
        competitor: true,
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
          "ActiveCampaign's agency program manages separate client accounts, each with its own contact-tier subscription.",
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
          "Package features into monthly or annual plans and charge each client through your own payment account — checkout links, automatic feature unlocks on payment, dunning grace + paywall, per-client special pricing, and one-time charges. ActiveCampaign's reseller program discounts accounts you resell at a capped margin.",
        leadstack: "Included",
        competitor: "Reseller margin",
      },
      {
        category: "Ownership & economics",
        label: "Per-client usage caps + overage rates — rebill usage at your prices",
        leadstack: "Included",
        competitor: false,
      },
      {
        category: "Ownership & economics",
        label: "White-label every client surface (login, domain, emails, booking, chat)",
        footnote:
          "ActiveCampaign offers an agency reseller program, but per its own program documentation there is no white-label interface — clients log into ActiveCampaign's app.",
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
        competitor: "Sales add-on",
      },
      {
        category: "CRM & sales",
        label: "Tasks",
        leadstack: true,
        competitor: "Sales add-on",
      },
      {
        category: "CRM & sales",
        label: "Calendar",
        leadstack: true,
        competitor: false,
      },
      {
        category: "CRM & sales",
        label: "Quotes / estimates — accept, decline, PDF",
        leadstack: true,
        competitor: false,
      },
      {
        category: "CRM & sales",
        label: "Product catalog",
        leadstack: true,
        competitor: false,
      },
      {
        category: "CRM & sales",
        label: "Invoices — card + PayPal payment links, auto-marked paid on card payment",
        leadstack: true,
        competitor: false,
      },
      {
        category: "CRM & sales",
        label: "Territory / team assignment",
        leadstack: true,
        competitor: "Sales add-on",
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
        competitor: "Pro+ tiers",
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
        competitor: "Landing pages only",
      },
      {
        category: "Lead capture & sites",
        label: "Booking pages — reminders + card deposits",
        leadstack: true,
        competitor: false,
      },
      {
        category: "Lead capture & sites",
        label: "Checkout pages — one-off offers with order bumps",
        leadstack: true,
        competitor: false,
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
        competitor: false,
      },
      {
        category: "Conversations & messaging",
        label: "Per-client dedicated email sending domain",
        leadstack: true,
        competitor: "One per account",
      },
      {
        category: "Conversations & messaging",
        label: "Dedicated per-client phone number (SMS)",
        leadstack: true,
        competitor: "Credit add-on",
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
        competitor: false,
      },
      {
        category: "Conversations & messaging",
        label: "Bulk email broadcasts",
        footnote:
          "ActiveCampaign's email sending is capped at 10–15× your contact tier per month depending on plan; beyond that you upgrade tiers.",
        leadstack: true,
        competitor: "Send-capped",
      },

      // ── AI ──────────────────────────────────────────────────────────────
      {
        category: "AI",
        label: "AI Web Chat widget",
        leadstack: "Included",
        competitor: false,
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
        label: "AI content + automation-building assistance",
        leadstack: true,
        competitor: true,
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
          "Workflows can wait for a contact's reply and branch either way — replied vs. went quiet — across SMS, WhatsApp, and Facebook/Instagram, with re-enrollment rules so nobody gets double-messaged. Ships as a ready-made template. ActiveCampaign's wait-until conditions cover email engagement, not conversational replies across channels.",
        leadstack: true,
        competitor: "Email only",
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
        competitor: false,
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
        competitor: "One per account",
      },
      {
        category: "Platform & developer",
        label: "Installable mobile app + push notifications — under YOUR brand",
        footnote:
          "The dashboard installs to a phone's home screen under your brand, with push notifications for a new lead, an inbound message, a new booking, a missed call, and a quote being accepted or declined. ActiveCampaign's mobile app is ActiveCampaign-branded.",
        leadstack: "Included",
        competitor: "AC-branded",
      },
      {
        category: "Platform & developer",
        label: "Bring contacts + automations logic across (CSV import, open API)",
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
        "Pay for LeadStack once. There are no contact tiers, no send caps, and no per-client subscriptions — every client is a sub-account in your own deployment, and a 50,000-contact list costs you the same platform fee as a 500-contact one: zero. Your only ongoing costs are the infrastructure your deployment actually consumes, paid directly to your providers at their published rates.",
      notes: [
        "Unlimited contacts and unlimited client sub-accounts: $0 — there is no contact meter and no per-workspace platform charge.",
        "Email sends: no platform cap — you pay your email provider's published per-send rates directly, which are a rounding error at small-agency volume.",
        "AI agents (Web Chat + SMS + Voice): $0/month — included with the license.",
        "SMS, quotes, invoices, booking pages, payments, social scheduling, review requests: all included — no add-on stack to assemble.",
        "Hosting, database, and email all run on generous free tiers that comfortably cover a small agency's first dozen sub-accounts.",
        "Typical all-in running cost for a small agency: around the price of a cup of coffee a month.",
        "Per-client usage caps and your own overage rates are built in — when you rebill usage to a client, the markup is yours, not a platform's.",
      ],
    },
    competitor: {
      headline: "Priced by the contact — and it compounds per client",
      detail:
        "ActiveCampaign's marketing tiers are priced by contact count, from $15/month at 1,000 contacts up to $589/month at 10,000 on Enterprise — with monthly email sends capped at 10–15× your contact limit. The sales CRM and SMS are add-ons. And because every client needs their own account, the whole curve repeats for each client you serve.",
      notes: [
        "At 2,500 contacts: Starter $39, Plus $95, Professional $149, Enterprise $255 per month (monthly billing).",
        "At 10,000 contacts: Starter $149, Plus $189, Professional $375, Enterprise $589 per month.",
        "Monthly email send caps: 10× your contact tier on Starter/Plus, 12× on Professional, 15× on Enterprise.",
        "SMS: credit-based add-on, purchased on top of the plan.",
        "Sales CRM (pipelines, tasks, deal management): an add-on to the marketing plans.",
        "Ten clients averaging 5,000 contacts each on Professional: roughly $24,600/year in subscriptions — repeating every year, with no ownership accrual.",
        "The agency reseller program discounts those accounts, but the margin is capped, the terms are ActiveCampaign's, and the app your clients use still carries their brand.",
      ],
    },
    summary:
      "For a single small list, ActiveCampaign is cheap to start. For an agency, the math inverts fast: the contact meter runs per client, forever, and every list you grow raises your own cost of goods. LeadStack's price is flat at zero platform fee — the license pays for itself inside the first year of a modest client roster, and every list can grow without a meter watching it.",
  },

  // Same ActiveCampaign public pricing as the notes above. $205/mo is
  // the Professional tier at ~5,000 contacts — the midpoint between the
  // published $149 (2,500 contacts) and $375 (10,000) rungs, and exactly
  // the per-client figure behind the "ten clients ≈ $24,600/year" note.
  // SMS credits and the Sales CRM add-on have no published flat price,
  // so they're deliberately left out — the modelled bill is the FLOOR.
  calculator: {
    heading: "Build your scenario — what does the contact meter cost?",
    intro:
      "ActiveCampaign is priced per contact, per account — and every client needs their own account. Slide your client count; the model assumes each client averages about 5,000 contacts on the Professional tier, before SMS credits or the Sales CRM add-on.",
    competitorTitle: "ActiveCampaign",
    unit: {
      sliderLabel: "Client accounts (one per client)",
      min: 1,
      max: 20,
      defaultValue: 10,
    },
    base: {
      label: "Professional (~5,000 contacts)",
      monthly: 205,
      per: "unit",
      hint: "Per client account — the meter grows with every list",
      leadstackHint: "One deployment, unlimited contacts + sub-accounts",
    },
    paybackNote:
      "at a typical client roster, payback lands inside the first month — and unlike a contact meter, the license price never grows with your lists. SMS credits and the Sales CRM add-on would push the ActiveCampaign side higher still.",
  },

  competitorWins: {
    heading: "Where ActiveCampaign genuinely wins",
    bullets: [
      "Email automation depth — the visual automation builder, split testing, and conditional content are among the best in the industry, refined over more than a decade.",
      "Deliverability reputation — consistently strong inbox placement, with predictive sending on higher tiers.",
      "A huge library of pre-built automation recipes and a marketplace of 900+ integrations.",
      "Free, hands-on migration services when you move onto their platform.",
      "A genuinely rare agency reseller program — most email platforms offer nothing at all for agencies.",
    ],
    closing:
      "If your business runs on one email list and sophisticated nurture sequences are the whole game, ActiveCampaign is a superb tool. This page is for a different buyer: the agency serving many clients across many channels, who'd rather own the platform than rent a seat on the meter.",
  },

  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        question: "Is LeadStack a true ActiveCampaign replacement for an agency?",
        answer:
          "For the agency use case — managing many clients' contacts, pipelines, email and SMS campaigns, booking, quotes, and AI-assisted lead response under your own brand — yes, and it covers a much wider surface than ActiveCampaign does: unified inbox, WhatsApp and social DMs, voice agents, booking pages, quotes and invoices, client billing. What it doesn't try to out-do is ActiveCampaign's deepest email-nurture machinery — if your entire business is one list with intricate multi-month drip logic, their automation builder is genuinely hard to beat.",
      },
      {
        question: "How is this different from ActiveCampaign's agency reseller program?",
        answer:
          "ActiveCampaign's program — to its credit, one of the few in the email space — lets you resell discounted accounts. But there's no white-label interface: your clients log into ActiveCampaign's app, the margin is capped by their discount schedule, and the pricing curve (per contact, per client) is theirs to change. With LeadStack you own the software outright: your brand on every screen, your prices, your entire margin, and no contact meter anywhere in the stack.",
      },
      {
        question: "Can I move my clients across from ActiveCampaign?",
        answer:
          "Yes, on your timeline. Contacts export cleanly from ActiveCampaign via CSV — custom fields and tags included — and import straight in; other records come across through the public REST API. Automations don't transfer mechanically (no two builders share a format), but the common agency sequences — welcome flows, speed-to-lead, no-reply follow-ups, review requests — ship as ready-made workflow templates you adapt in minutes. Most agencies onboard new clients first, run both side by side, and migrate the rest at renewal.",
      },
      {
        question: "How does the white-label work?",
        answer:
          "You deploy LeadStack to your own cloud under your own domain and set your brand in one config file — name, logo, tagline, support email, pricing. Every surface your clients touch renders as your brand: the landing page, every dashboard screen, transactional emails, public booking pages, the AI chat widget, and customer-facing quote pages. The LeadStack name never appears. And each sub-account can carry its own sending domain and dedicated phone number, so your clients see fully separate brands right down to the channel.",
      },
      {
        question: "What does it actually cost to run?",
        answer:
          "After the one-time license, a small agency runs on the generous free tiers across hosting, database, and email — around the price of a cup of coffee a month. There is no contact tier and no send cap: email costs are your provider's published per-send rates, paid directly, with no platform markup. Compare that to a per-client ActiveCampaign subscription that grows with every list you succeed in building.",
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
    body: "LeadStack gives agencies a full all-in-one CRM as code they own, on infrastructure they control, with every channel built in — no contact tiers, no send caps, no platform fee.",
    primaryCtaLabel: "See LeadStack pricing",
    primaryCtaHref: "/#pricing",
  },
};
