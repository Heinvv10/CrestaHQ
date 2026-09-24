import { GET_LEADS_PARKED } from "@/lib/get-leads/business-types";
import type { AiSuiteKnowledgeCard } from "@/types/ai-suite";

/**
 * Get Leads card — kept out of the live KB while the feature is PARKED so
 * the assistants never describe (or send users hunting for) a surface that
 * isn't in the app. Splices back in automatically when the flag flips.
 */
const GET_LEADS_CARD: AiSuiteKnowledgeCard = {
  id: "get-leads",
  levels: ["sub-account"],
  title: "Get Leads (experimental prospecting)",
  location: "Sidebar → Get Leads",
  keywords: ["get leads", "prospect", "prospecting", "find businesses", "local business", "google maps", "lead finder", "scrape", "no website", "radius", "map", "import leads", "custom service", "tag"],
  body:
    "Get Leads finds local businesses that might need whatever you sell. Pick a business type (a curated list, plus your own — admins click Manage services to add or remove service types), set a location (start typing and pick from the suggestions that appear, or use your current location), a radius, and Max results (10/20/40 — this caps how many businesses come back AND how many enrichment credits one search can spend, so you can't burn credits in a single run), then search — results take 1–3 minutes because each business is enriched with emails and social links. Results show on a map and an enriched list (phone, email, website, rating); amber pins and the 'No website' filter flag businesses without a website. Tick the ones you want, optionally edit the 'Tag as' value (pre-filled from the search, e.g. 'plumbers-brisbane'), and click Import to create contacts (source 'Prospecting', tagged 'prospecting' plus that tag; duplicates by phone/email are skipped). If the agency has also enabled Prospecting, 'Save as list' keeps the search as a named prospect list (Sidebar → Prospecting) and every import from that result set is linked to it. Follow up using the tag: a Workflow with the 'contact created' trigger filtered to that tag, a Broadcast to that tag's audience, or an outbound voice campaign over it. The businesses themselves aren't saved — import before leaving the page. It's experimental and agency-gated: if it shows 'Locked', ask your agency owner to enable it. The deployment also needs an Outscraper API key configured (searches spend the agency's Outscraper credits).",
};

/**
 * The AI Suite knowledge base.
 *
 * Each card is one feature's how-to, grounded in how the app actually
 * behaves. The `title` + `location` are aligned to the real sidebar nav and
 * route tree (`SUB_ACCOUNT_NAV` in components/dashboard/sidebar.tsx and the
 * routes under app/(dashboard)); the `body` is the authoritative content the
 * assistant is allowed to state.
 *
 * This is the "auto-generate from code/UI" source the plan called for, kept
 * as a maintained data file so a future build-time generator can refresh the
 * structural fields (title/location/keywords) from the nav + route tree while
 * the bodies stay reviewable. Add a card when a feature ships; the retriever
 * and prompt pick it up automatically.
 */
export const AI_SUITE_KNOWLEDGE: AiSuiteKnowledgeCard[] = [
  // ─────────────────────────── Sub-account features ───────────────────────
  {
    id: "workspace-assistant",
    levels: ["sub-account", "agency"],
    title: "The assistants (Workspace Assistant & Agency Assistant)",
    location: "Sidebar → Workspace Assistant / Agency → Agency Assistant",
    keywords: ["assistant", "ai suite", "chatbot", "help", "actions", "confirm", "safe", "permissions", "what can you do"],
    body:
      "Two in-app AI assistants: the Workspace Assistant (in each sub-account, scoped strictly to that one workspace's data) and the Agency Assistant (agency owner only — can answer across sub-accounts and act inside a named one). Both answer how-to questions and perform a fixed set of actions; every action shows a confirmation card and nothing runs until you confirm. All executed actions are audit-logged. Both are OFF by default because replies use the agency's AI credits: the agency owner enables the Workspace Assistant per sub-account from the Manage dialog, and the Agency Assistant from Agency → Settings Agency → Agency Assistant.",
  },
  {
    id: "contacts",
    levels: ["sub-account"],
    title: "Contacts",
    location: "Sidebar → Contacts",
    keywords: ["contact", "lead", "people", "import", "csv", "export", "notes", "activity", "tags", "custom field", "consent", "opted out", "stop", "sms consent"],
    body:
      "Contacts holds every lead and customer for the sub-account. Add or edit a contact from the add/edit modal, and open a contact to see its profile with notes and a unified activity timeline. The profile also shows a Details card (the workspace's custom-field values — blanks shown as dashes so you can see what's missing) and an SMS consent card with one of four states: consented via a form (with the exact wording, date, and page on record), declined on a form (liftable if they consent later), opted out at the carrier (the customer texted STOP — only them texting START lifts it; it can't be cleared in-app), or never asked (imports/manual entries). Opted-out and declined contacts can't be texted from anywhere in the app. You can import and export contacts as CSV. Contacts carry a source badge (e.g. Web Chat, Booking, Form) showing where they came from, plus captured marketing attribution (UTM/referrer) when they arrived via a public form. The assistant can add a contact (with tags) or search contacts for you.",
  },
  {
    id: "custom-fields",
    levels: ["sub-account"],
    title: "Custom fields (contacts & deals)",
    location: "Sidebar → Settings Sub-Account → Custom Fields tab",
    keywords: ["custom field", "custom fields", "extra field", "field type", "dropdown", "define field", "contact field", "deal field", "required field"],
    body:
      "Custom Fields lets a workspace admin define its own fields on contacts and deals — pick the entity (contact or deal), a label, a type (text, number, date, dropdown, etc.), and whether it's required. Defined fields then appear on the contact and deal add/edit forms and store per-record values, and every contact's values display read-only on the Details card at the top of their profile (blank fields show as dashes — a prompt for what's still to collect). Managed under Settings → Custom Fields tab (admin-only to define; everyone can fill values).",
  },
  {
    id: "google-reviews",
    levels: ["sub-account", "agency"],
    title: "Google review requests (SMS & WhatsApp)",
    location: "Sidebar → Settings Sub-Account → Messaging tab → Google reviews",
    keywords: ["google review", "review", "reviews", "review request", "review automation", "reputation", "5 star", "rating", "review link", "ask for review", "request review"],
    body:
      "Google review requests send a 'leave us a review' message to a contact over SMS or WhatsApp, with the workspace's Google review link. Set it up under Settings → Messaging tab → Google reviews: paste the Google review URL, pick the channel (SMS free-form; WhatsApp requires the agency WhatsApp gate + a configured WhatsApp sender, and auto-sends need an approved WhatsApp template), and edit the message ({{firstName}}, {{businessName}}, {{reviewUrl}} merge tags). Two ways to send: manually — a 'Request a Google review' button on a contact's profile (shown once the review URL is configured; contact needs a phone number) — or automatically when a quote/invoice is marked paid or a deal is completed (each auto trigger is its own toggle). Auto-sends respect a per-contact cooldown (default 90 days) and opt-outs; every request is logged on the contact's activity timeline and in the unified inbox.",
  },
  ...(GET_LEADS_PARKED ? [] : [GET_LEADS_CARD]),
  {
    id: "pipeline",
    levels: ["sub-account"],
    title: "Pipeline (Kanban)",
    location: "Sidebar → Pipeline",
    keywords: ["pipeline", "kanban", "deal", "stage", "drag", "won", "lost", "board", "opportunity", "value"],
    body:
      "Pipeline is a drag-and-drop Kanban board with six stages (New → Contacted → Qualified → Proposal → Won / Lost). Each deal card shows its value and days-in-stage. Drag a deal across stages to update it; moving to Lost prompts for a lost reason. Open a deal to edit it — the edit panel also has a Delete action (with a confirm) for removing a deal entirely. One contact can have multiple deals. Accepted quotes can auto-create a Won-stage deal. The assistant can create a deal for a contact, move a deal to another stage (including Won/Lost), and give you a pipeline snapshot with counts and values per stage.",
  },
  {
    id: "calendar",
    levels: ["sub-account"],
    title: "Calendar",
    location: "Sidebar → Calendar",
    keywords: ["calendar", "event", "appointment", "month", "schedule"],
    body:
      "Calendar is a month grid for manual events. Click a day to add an event, optionally link it to a contact, and it writes to the contact's activity timeline. Public self-service booking is handled separately under Booking.",
  },
  {
    id: "booking",
    levels: ["sub-account"],
    title: "Booking pages",
    location: "Sidebar → Booking",
    keywords: ["booking", "calendly", "slot", "appointment", "self-service", "reschedule", "cancel", "reminder", "booking link", "bookinglink", "merge tag", "voice booking", "host", "team", "staff", "host selection", "pick a person", "assign", "per-host hours", "round robin"],
    body:
      "Booking is a Calendly-style public slot picker per sub-account. Configure a booking page (durations, working hours, required fields, optional price and reminders), then share its public URL. A visitor picks a slot; the server re-verifies availability, reconciles a contact, creates a calendar event, and sends an ICS-attached confirmation email. Reschedule, cancel, reminders, and paid-hold expiry are handled automatically. TEAM PAGES: in the page editor's 'Hosts / team' section you can add team members as hosts — a time then stays open while any host is free and each booking auto-assigns to the least-busy host. Two opt-in extras there: tick 'Let customers pick a specific person' to show an 'Anyone available' / named-host dropdown on the public page (off by default; the page never exposes staff names until you turn it on), and tick 'Custom hours for this host' on any host to give them their own schedule (own days off) instead of the page hours. When a customer picks a specific person, the confirmation email and calendar invite name that host, and the assigned host is emailed the booking details. The Booking page also has a 'Default booking link' card (admins): pick one of your published booking pages or paste a custom URL (e.g. Calendly) — that URL is what the {{bookingLink}} merge tag resolves to in workflows, broadcasts, and templates, and it's the link the AI agents share when someone asks to schedule.",
  },
  {
    id: "tasks",
    levels: ["sub-account"],
    title: "Tasks",
    location: "Sidebar → Tasks",
    keywords: ["task", "todo", "due", "overdue", "follow up", "reminder"],
    body:
      "Tasks organizes todos into Today / Overdue / Upcoming / Done, with a due-today badge in the sidebar. Tasks can be linked to a contact. Several features auto-create follow-up tasks — e.g. a Web Chat or Voice lead capture creates a 'follow up' task due today. The assistant can create a task for you, with a due date and an optional linked contact.",
  },
  {
    id: "forms",
    levels: ["sub-account"],
    title: "Forms",
    location: "Sidebar → Forms",
    keywords: ["form", "builder", "field", "public", "embed", "iframe", "capture", "landing", "spam", "bot", "honeypot", "captcha"],
    body:
      "Forms is a drag-order field builder with six field types that map to contact fields. Each form gets a public hosted page and an iframe embed snippet. On submit it auto-creates a contact (and optionally a deal), captures marketing attribution, and can trigger the Speed-to-Lead automation. Attach automations from the form's Automation panel. Spam protection is built in and always on with nothing to configure: a hidden honeypot field, a too-fast-to-be-human submit check, and a per-IP rate limit (bots get a silent fake success and create nothing; a real visitor over the limit sees a retry-in-a-few-minutes message). There is no captcha (reCAPTCHA/Turnstile) option today.",
  },
  {
    id: "products",
    levels: ["sub-account"],
    title: "Products catalog",
    location: "Sidebar → Products",
    keywords: ["product", "catalog", "price", "item", "invoice", "line item"],
    body:
      "Products is a reusable per-sub-account catalog (name, description, unit price, currency, active flag). When building a quote or invoice, use 'Add from catalog' to snapshot a product into a line item — editing a product later never changes historical quotes/invoices.",
  },
  {
    id: "quotes-invoices",
    levels: ["sub-account"],
    title: "Quotes & Invoices",
    location: "Sidebar → Quotes",
    keywords: ["quote", "estimate", "invoice", "line item", "accept", "decline", "paid", "paypal", "stripe", "card", "pay", "send"],
    body:
      "Quotes lets you build a line-itemed quote (with discount, tax, terms, validity), send it via a branded email, and the recipient views and accepts or declines on a public page. Accepting can auto-create a Won-stage deal, and you get a push notification when a quote is accepted or declined (if you've enabled notifications). A quote can be converted to an invoice. Invoices need a payment rail connected under Settings → Payments: with Stripe connected (agency-gated) the recipient pays by card on the invoice page and it's marked paid automatically; with a PayPal.me username the invoice shows a PayPal 'Pay' button and you mark it paid manually after the money lands. Sending requires Resend (email) to be configured on the deployment.",
  },
  {
    id: "website",
    levels: ["sub-account", "agency"],
    title: "Website builder",
    location: "Sidebar → Website",
    keywords: ["website", "site", "gitpage", "landing", "publish", "build", "vsl", "niche", "template", "like a site", "gym site"],
    body:
      "Website builds a marketing site per sub-account via gitpage.site — fill the sectioned form (Basics / Pages / Services / Design / FAQ), choose Local (multi-page) or VSL (single-page video funnel), optionally pick a niche template (Gym & Fitness, Home Services, Real Estate), and click Build. The build queues and publishes to a live URL in a few minutes. Each sub-account can hold up to 5 sites. The assistant can also build a site for you from a description ('build me a gym website like fitness.com') — it can read a reference site for tone, picks the matching niche template, drafts the copy, and submits the build after you confirm; it can also check whether a build is done. Niche templates need the business's street address. This feature is agency-gated: if the Website entry shows a 'Locked' badge, ask your agency owner to enable it.",
  },
  {
    id: "workflows",
    levels: ["sub-account"],
    title: "Workflows (visual automation builder)",
    location: "Sidebar → Workflows",
    keywords: ["workflow", "automation", "builder", "speed to lead", "trigger", "sms", "email", "drip", "nurture", "publish", "template", "wait for reply", "no reply", "follow up", "branch", "re-enroll"],
    body:
      "Workflows is a visual automation builder: pick a trigger (form submitted, contact created, tag added, deal stage changed, booking created/confirmed/cancelled/rescheduled/showed/no-show (optionally filtered to one booking page), quote accepted, quote/invoice paid, or message received — the last with an optional channel filter), then chain steps like send SMS, send email, send WhatsApp template, wait, and create task. Two branching steps: If/else (conditions on the contact, matched ALL or ANY) and Wait for reply — 'if they don't reply within N days, do X': it takes the Replied branch the moment the contact messages back (SMS, WhatsApp, or Facebook/Instagram — email replies can't be detected because they go straight to your own inbox) or the No-reply branch when the window ends. Each workflow has a re-enrollment setting: every time, not while already in the workflow, or only once per contact. Start from a template — Speed-to-Lead, Appointment Confirmation, Lead Nurture, Stage-Change Follow-up, No-reply Follow-up — or blank. Workflows are created as drafts; publish to make them live, and check per-run history under the workflow's Runs. Emails must include the unsubscribe link. Delayed steps run through a background queue, so workflows need QStash configured on the deployment. The assistant can create a workflow from a starter template for you (as a draft). Related settings — the Reply-To address, sending-hours window, and the 'Pause all workflows' switch — live under Sidebar → Settings → Sending preferences (Messaging tab), not on the Workflows page.",
  },
  {
    id: "ai-agents",
    levels: ["sub-account"],
    title: "AI Agents",
    location: "Sidebar → AI Agents",
    keywords: ["ai agent", "bot", "web chat", "sms", "whatsapp", "messenger", "instagram", "voice", "persona", "channel", "openrouter", "outbound", "booking link"],
    body:
      "AI Agents is one persona (system prompt + business hours + escalation keywords + optional website knowledge base) that answers across channels. Configure the shared persona on the Overview, then enable channels: Web Chat (an embeddable widget), SMS and WhatsApp (auto-replies on the dedicated Twilio number), Messenger & Instagram (auto-replies to DMs on the connected Meta Page), and Voice (AI answers inbound calls — and can BOOK appointments live during the call: pick a published booking page under Voice settings → 'Live appointment booking' and the agent offers real slots and books the caller in, phone-only, no deposit pages). Outbound Voice proactively dials contacts. Business hours default to 24/7; to set a window pick start and end hours on the Overview ('24:00 (midnight)' covers through the end of the day, and start = end means always on). Outside the window, SMS/WhatsApp/Messenger replies pause and web chat answers with a we're-closed note; inbound Voice answers regardless of hours. Every channel needs a non-empty persona prompt first; Twilio channels need a dedicated Twilio number (Settings → SMS) and Messenger & Instagram needs the Meta connection (Settings → Facebook & Instagram). When the workspace has a default booking link set (Booking page), every agent shares it when someone wants to schedule. Note: AI Agents answers your CLIENTS' inbound messages — the Workspace Assistant (this assistant) helps YOU use the app, and is separate.",
  },
  {
    id: "messenger-instagram-ai",
    // Dual-level: sub-account operators ask "why isn't the bot answering my
    // DMs / why is this locked", and the agency owner flips both gates.
    levels: ["sub-account", "agency"],
    title: "Messenger & Instagram AI auto-reply",
    location: "Sidebar → AI Agents → Messenger & Instagram",
    keywords: ["messenger", "instagram", "dm", "facebook", "auto reply", "ig bot", "meta", "dm bot", "instagram bot", "facebook bot", "social inbox ai", "not replying"],
    body:
      "The Messenger & Instagram channel lets the shared AI agent answer inbound Facebook Messenger and Instagram DMs automatically — one switch covers both platforms, and the reply always goes back on the platform the DM arrived on. Prerequisites, in order: the agency owner must enable BOTH the 'Facebook + Instagram inbox' gate AND the 'Messenger & Instagram AI auto-reply' gate (Agency → Sub-accounts → Manage — they're separate switches because the bot spends the agency's AI credits); a Facebook Page must be connected under Settings → Facebook & Instagram; and the agent persona must be saved on the AI Agents Overview. If the Meta connection is missing Instagram messaging permission, the bot answers Messenger only and the settings page shows how to fix it (Reconnect and approve Instagram access). Replying to a conversation manually from the inbox pauses the bot on that thread, and each conversation's AI controls (auto / suggest a draft / off) apply — in suggest mode the bot's reply appears as a draft you approve before it sends.",
  },
  {
    id: "voice-live-booking",
    levels: ["sub-account"],
    title: "Voice agent live appointment booking",
    location: "Sidebar → AI Agents → Voice → Live appointment booking",
    keywords: ["voice booking", "book appointment", "phone booking", "ai book", "book over the phone", "voice agent book", "book a call", "schedule by phone", "live booking", "book caller", "follow up task", "confirm booking", "host", "which staff", "specific person", "team member", "book with"],
    body:
      "The inbound Voice AI can book real appointments during a call. Turn it on under AI Agents → Voice → 'Live appointment booking' by picking one of your PUBLISHED booking pages (deposit-taking pages can't be booked by phone and aren't listed). When a caller wants to book, the agent checks live availability on that page, offers up to three times from the next 7 days, asks the caller's name, and books the slot — the appointment lands on the calendar as a normal booking (same activity log and workflow triggers), assigned automatically in team mode. If the chosen page has 'Let customers pick a specific person' turned on, the agent asks early in the call which team member they'd like (or 'anyone available'), offers only that person's times, and books with them; the assigned host is emailed the booking details. Bookings are phone-only: no email is collected, so no confirmation email or reminders are sent to the caller — the caller is identified by caller ID (new callers become a contact with source 'Voice'). Because nothing is emailed to the caller, every booking attempt creates a team follow-up Task after the call ends: a 'Follow up with…' task when a booking was made (a nudge to confirm the appointment with the caller), or a 'Call back…' task when a caller tried to book but the call ended before a time was locked in. If a time gets taken mid-call the agent apologises and offers alternatives; if nothing suits, it falls back to offering the workspace's booking link. Prerequisites: the Voice channel must be enabled (with its usual Vapi + Twilio setup), and the chosen page must stay published.",
  },
  {
    id: "conversations",
    levels: ["sub-account"],
    title: "Conversations (unified inbox)",
    location: "Sidebar → Conversations",
    keywords: ["conversation", "inbox", "message", "reply", "unified", "thread", "chat"],
    body:
      "Conversations is a unified inbox across SMS, WhatsApp, and (when enabled) Facebook/Instagram DMs. Open a thread to read history and reply from the composer; the available send channels depend on what's connected and whether the contact has messaged on that channel. Each conversation has AI controls (auto-reply / suggest a draft / off) for the channel bots, and replying manually pauses the bot on that thread; in suggest mode the AI's reply appears as a draft you edit and approve before it sends. An unread badge appears in the sidebar.",
  },
  {
    id: "broadcasts",
    levels: ["sub-account"],
    title: "Broadcasts (bulk email)",
    location: "Sidebar → Broadcasts",
    keywords: ["broadcast", "bulk", "email", "blast", "campaign", "audience", "send"],
    body:
      "Broadcasts sends an email template to a filtered audience (all contacts, a tag, or a pipeline stage). It reuses the automations engine and every email must include the unsubscribe link. Opted-out and email-less contacts are skipped automatically. Broadcasts is agency-gated — if it shows 'Locked', ask your agency owner to enable it. Bulk SMS is not available.",
  },
  {
    id: "social",
    levels: ["sub-account"],
    title: "Social Planner",
    location: "Sidebar → Social Planner",
    keywords: ["social", "post", "facebook", "instagram", "schedule", "publish", "planner", "meta"],
    body:
      "Social Planner schedules and auto-publishes posts to a connected Facebook Page and Instagram Business account. Compose a caption, paste an image URL, pick Facebook/Instagram targets and a time; posts publish at the scheduled time. It rides the same Facebook/Instagram connection as the inbox (connect it under Settings → Facebook & Instagram). Agency-gated and Meta-only.",
  },
  {
    id: "community",
    levels: ["sub-account"],
    title: "Community & Courses",
    location: "Sidebar → Community",
    keywords: ["community", "course", "group", "skool", "classroom", "member", "feed", "standalone course", "sell course", "courses only", "sales page", "promo video", "curriculum"],
    body:
      "Community is a Skool-style space with a group feed, a classroom for courses (sections + lessons with YouTube/Vimeo video), leaderboards, and gamification. Groups can be free or paid, open-join or approval-required; members join via magic link and are tied to contacts — share the community's public URL to invite them. Each group has a mode setting: 'Full community' or 'Courses only'. A Courses-only group presents as a standalone course — the feed, members list and leaderboards are hidden, members land straight in the classroom, and the public page reads as a course sales page (add a YouTube/Vimeo promo video in group settings; a curriculum overview of published lessons renders automatically). To sell a standalone course: create a Courses-only group, set Access to Paid with a price, add the course inside as 'Open to all members', publish both, and share the group's public URL. Paid access is collected by card via the workspace's connected Stripe (auto-granted on payment) or PayPal.me (staff mark paid manually). It's agency-gated — if 'Locked', ask your agency owner to enable it. The assistant can set up a new free community for you, including its first course and lesson, and give you the live URLs.",
  },
  {
    id: "community-group-modes",
    levels: ["sub-account", "agency"],
    title: "Group modes: full community vs courses only (standalone courses)",
    location: "Sidebar → Community → open a group → Group mode",
    keywords: ["group mode", "courses only", "course only", "standalone course", "sell a course", "hide feed", "no community", "digital product", "course sales page", "switch mode", "full community", "classroom only"],
    body:
      "Every community group has a Group mode setting with two options. 'Full community' is the complete Skool-style experience: a feed, the classroom, a members directory, and leaderboards. 'Courses only' turns the same group into a standalone course product: the feed, members list and leaderboards disappear from the member experience, members land straight in the classroom after signing in, and the group's public page reads as a course sales page — with an optional YouTube/Vimeo promo video (set in group settings) and an automatic curriculum overview listing the published sections and lessons. Pricing works the same in both modes: set the group's Access to Free or Paid (one-time price). For a paid courses-only group the recommended shape is one group per course — the group's price IS the course price, and the course inside is set to 'Open to all members'. Buyers sign in with an email magic link, pay by card through the workspace's connected Stripe (access is granted automatically on payment) or via a PayPal.me link (staff click Mark paid), and land in the classroom. Switching modes is safe in either direction and deletes nothing — feed posts, members, and points are all kept and simply hidden while in Courses only, so a course can later be grown into a full community by switching back. Choose the mode when creating the group or change it anytime in the group's settings.",
  },
  {
    id: "labs",
    levels: ["sub-account", "agency"],
    title: "Labs (pre-release features & the Follow-up Watchdog)",
    location: "Sidebar → Labs",
    keywords: ["labs", "experimental", "beta", "watchdog", "follow-up watchdog", "inbox watchdog", "agent", "autonomous", "unanswered", "waiting on reply", "pre-release"],
    body:
      "Labs is the home for pre-release, experimental features. It's agency-gated (hidden by default — the agency owner enables the Labs gate per sub-account from the Manage dialog). Its first resident is the Inbox Follow-up Watchdog: an hourly background agent that scans the unified inbox for conversations where a customer wrote in and nobody replied for longer than your threshold, uses AI to judge which ones genuinely need a follow-up, and for each flagged thread creates a Task and sends a push notification to the team. It only ever ADDS internal items — it never messages customers or changes records. Configure it on the Labs page: on/off toggle, the waiting threshold (1–24 hours), optional extra judging criteria, quiet hours for pushes, and a recent-runs log. It also requires the Workspace Assistant (AI Suite) gate to be on, since judgments spend the agency's AI credits.",
  },
  {
    id: "reports",
    levels: ["sub-account"],
    title: "Reports",
    location: "Sidebar → Reports",
    keywords: ["report", "kpi", "funnel", "revenue", "chart", "analytics", "attribution", "source"],
    body:
      "Reports shows date-range KPIs, a pipeline funnel, a won-revenue chart, and a leads-by-source donut. There's also a revenue-attribution view (first-touch, forms-only) tying revenue back to the source that generated it.",
  },
  {
    id: "sa-settings",
    levels: ["sub-account"],
    title: "Sub-account settings",
    location: "Sidebar → Settings Sub-Account",
    keywords: ["settings", "twilio", "sms", "email domain", "api key", "webhook", "payments", "paypal", "members", "send window"],
    body:
      "Settings is where you configure the sub-account, organized into tabs: Admin (members + invites, territory scoping, branding), Messaging (dedicated Twilio SMS — paste your Account SID, Auth Token, and From number to enable SMS threads + AI channels — plus Missed Call Text Back, Google reviews, a dedicated email sending domain (agency-gated), Sending preferences, and the Facebook & Instagram connection), API (API keys + webhooks for the public API, agency-gated, plus PayPal.me for invoice payments), Custom Fields (define fields on contacts/deals), and Importer (migrate from GoHighLevel). Note: turning dedicated Twilio SMS OFF again (falling back to the shared sender) is an agency-owner action — on the shared sender, customer replies can't be routed back to the workspace.",
  },
  {
    id: "missed-call-text-back",
    levels: ["sub-account", "agency"],
    title: "Missed Call Text Back",
    location: "Sidebar → Settings Sub-Account → Messaging tab → SMS section",
    keywords: ["missed call", "text back", "mctb", "missed call text back", "call forward", "ring timeout", "auto text", "missed caller", "call back sms"],
    body:
      "Missed Call Text Back automatically texts a caller who rings the sub-account's dedicated Twilio number and isn't answered — optionally forwarding the call to a real phone first (with a configurable ring timeout) and sending the auto-SMS only if nobody picks up. Configure it in Settings → Messaging tab under the SMS section: enable it, set the forward-to number, ring timeout, and the text-back message. Prerequisites: the agency owner must enable the Missed Call Text Back gate for this sub-account, and dedicated Twilio SMS must be configured. It can't be combined with the inbound Voice AI agent (both would answer the same line — pick one). A missed call also fires a push notification to team members who have notifications on.",
  },
  {
    id: "territory-scoping",
    levels: ["sub-account"],
    title: "Territory scoping (team assignment)",
    location: "Sidebar → Settings Sub-Account → Admin tab",
    keywords: ["territory", "territories", "region", "team assignment", "assign rep", "restrict access", "scoping", "sales region", "who sees what"],
    body:
      "Territory scoping is an opt-in restriction that pins collaborators to their assigned territories: when enabled, a collaborator only sees the contacts and deals whose territory is in their assigned list — admins and the agency owner always see everything. Turn it on under Settings → Admin tab, then create territories and assign them to members. Enabling auto-seeds a 'Global' territory and gives every member Global by default, so nobody's pipeline goes blank — then carve out real territories and move reps off Global. Disabling preserves all territory data (re-enabling is one click); while off, territory chips and pickers are hidden everywhere.",
  },
  {
    id: "ghl-import",
    levels: ["sub-account", "agency"],
    title: "GoHighLevel migration import",
    location: "Sidebar → Settings Sub-Account → Importer tab",
    keywords: ["gohighlevel", "ghl", "import", "migrate", "migration", "switch from", "move contacts", "opportunities", "pipeline mapping", "bring clients across"],
    body:
      "The Importer tab (Settings → Importer) has a GoHighLevel migration wizard that pulls a GHL sub-account's data into this workspace: contacts (including custom fields and tags), opportunities/deals with a configurable mapping from GHL pipeline stages to this workspace's stages, and notes. Connect by pasting a GHL Private Integration Token plus the location id (validated live, stored server-only), preview what will come across, then start the import — it runs in the background and reports progress. Sub-account admin only. Plain CSV import (from any system) is separate and lives on the Contacts page.",
  },
  {
    id: "sending-preferences",
    levels: ["sub-account"],
    title: "Sending preferences (Reply-To, send window, pause workflows)",
    location: "Sidebar → Settings Sub-Account → Sending preferences (Messaging tab)",
    keywords: ["reply-to", "reply to", "replies", "bounce", "send window", "quiet hours", "sending hours", "pause", "pause workflows", "pause automations", "stop workflows", "kill switch"],
    body:
      "The Sending preferences card (Settings → Messaging tab) holds three workspace-wide controls. (1) Reply-To email: replies to every automated and broadcast email route to this address — required before using a dedicated sending domain, because the domain has no inbox and replies to it would bounce. (2) Sending hours: an optional window (start hour, end hour, timezone) so workflow messages outside it wait for the next window start instead of sending overnight. (3) Pause all workflows: an emergency stop — while paused, no workflow triggers fire and in-flight runs stop at their next step; resume from the same card. These used to live on the old Automations settings page; they're in Settings now.",
  },
  {
    id: "api-webhooks",
    levels: ["sub-account"],
    title: "Public API & outbound webhooks",
    location: "Sidebar → Settings Sub-Account → API Keys / Webhooks",
    keywords: ["webhook", "api", "n8n", "make", "zapier", "integration", "endpoint", "trigger", "automation tool", "signing secret", "events", "rest"],
    body:
      "Each sub-account can integrate with external tools two ways. (1) Outbound webhooks: register an endpoint URL (from n8n, Make, Zapier, or custom) plus an event allowlist, and matching events (contact.created, deal.won, form.submitted, quote.accepted, booking.created, message.received, …) get POSTed to it, signed Stripe-style with a per-subscription secret. One webhook covers ONE event category — create one per category. Failed deliveries retry with backoff; 10 straight failures auto-pauses the webhook. (2) REST API: mint keys (lsk_live_/lsk_test_) under API Keys for inbound calls. Both require the agency owner to enable API access for this sub-account (a feature gate). The assistant can set up a webhook for you — just say what should trigger it and give the endpoint URL, and it sends a test event to verify it's live. n8n users: n8n shows two URLs per webhook node — the Test URL (/webhook-test/, only works while the editor is listening) and the Production URL (/webhook/, requires the workflow's Active toggle ON). Use the Production URL for permanent hooks.",
  },
  {
    id: "templates",
    levels: ["sub-account"],
    title: "Templates (email & SMS)",
    location: "Sidebar → Templates",
    keywords: ["template", "email template", "sms template", "merge tag", "unsubscribe", "message", "reusable"],
    body:
      "Templates holds reusable email and SMS message bodies with merge tags (e.g. {{contact.firstName}}) that personalize per recipient. Workflows and Broadcasts pick from these templates when sending. {{bookingLink}} resolves to the workspace's default booking link, set on the Booking page. Every email template must include {{unsubscribeLink}} — the editor enforces it for compliance.",
  },
  {
    id: "dashboard",
    levels: ["sub-account"],
    title: "Dashboard",
    location: "Sidebar → Dashboard",
    keywords: ["dashboard", "home", "kpi", "overview", "leads map", "summary", "activity"],
    body:
      "Dashboard is the workspace home: KPI summary, a pipeline snapshot, recent activity, and a leads map with clustered pins showing where contacts came from (locations are captured on public form submissions; the map needs a Mapbox token configured on the deployment).",
  },
  {
    id: "logs",
    levels: ["sub-account"],
    title: "Logs (API & webhook deliveries)",
    location: "Sidebar → Logs",
    keywords: ["logs", "delivery", "webhook log", "api log", "debug", "failed", "retry", "redeliver"],
    body:
      "Logs shows integration history for the workspace: recent public-API requests per key, and outbound webhook events with each delivery attempt (HTTP status, error, retries). Use it to debug an integration — a failing webhook shows the response your endpoint returned, and you can redeliver an event after fixing the endpoint.",
  },
  {
    id: "search",
    levels: ["sub-account"],
    title: "Global search (Cmd/Ctrl+K)",
    location: "Anywhere → press Cmd/Ctrl + K",
    keywords: ["search", "find", "command", "palette", "cmd k", "shortcut"],
    body:
      "Press Cmd+K (Mac) or Ctrl+K (Windows) on any dashboard page to open a global search palette across contacts, deals, tasks, events, and forms.",
  },

  // ───────────────────────────── Agency features ──────────────────────────
  {
    id: "agency-sub-accounts",
    levels: ["agency"],
    title: "Sub-accounts (create & manage)",
    location: "Agency → Sub-accounts",
    keywords: ["sub-account", "subaccount", "create", "client", "workspace", "new", "add", "manage"],
    body:
      "Each client gets a sub-account — an isolated workspace with its own contacts, pipeline, and data. Create one from Agency → Sub-accounts → create; it's assigned a human-readable account number automatically and seeded with default templates. Use the per-row Manage button to rename it, manage members, and control its feature gates. The Agency Assistant can create a sub-account for you, list them with their gates, report a sub-account's record counts and pipeline, and perform workspace actions (contacts, tasks, deals, workflows, webhooks, communities) inside a sub-account you name.",
  },
  {
    id: "agency-snapshots",
    levels: ["agency"],
    title: "Snapshots (reusable sub-account templates)",
    location: "Agency → Sub-accounts → Snapshots",
    keywords: ["snapshot", "snapshots", "template", "clone", "duplicate sub-account", "copy setup", "reusable config", "start from snapshot", "onboard client"],
    body:
      "Snapshots let the agency owner capture a proven sub-account setup — its forms, message templates, products, and workflows — into a reusable template, then apply it when creating a new sub-account via the 'Start from a snapshot' picker on the new sub-account form. Customer data and credentials are never copied — only the reusable configuration. Capture and manage the snapshot library from the Snapshots panel on the Agency → Sub-accounts page (agency owner only). It's the fast way to onboard a new client with a setup you've already refined.",
  },
  {
    id: "agency-feature-gates",
    // Dual-level: sub-account operators hit "why is this Locked?" questions
    // and need to know it's their agency owner who flips the gate.
    levels: ["agency", "sub-account"],
    title: "Feature gates",
    location: "Agency → Sub-accounts → Manage",
    keywords: ["gate", "enable", "disable", "lock", "feature", "permission", "website", "broadcasts", "api", "whatsapp", "social", "community", "assistant", "labs", "ai model", "get leads", "prospecting"],
    body:
      "Feature gates let the agency owner turn optional features on or off per sub-account — features that consume agency resources (email sending domains, the public API + webhooks, broadcasts, WhatsApp, outbound voice, website builds, the Facebook + Instagram inbox, the Messenger & Instagram AI auto-reply — a separate switch layered on the inbox gate — Social Planner, Community, Missed-Call Text-Back, Get Leads, Prospecting, the Workspace Assistant, and Labs). Those are all off by default. Three AI channels are ON by default and can be switched OFF per sub-account instead: SMS AI auto-reply, Web Chat AI, and Inbound Voice AI. Open a sub-account's Manage dialog and tick the gates; the same dialog also holds the per-sub-account AI model picker (which model the assistants use for that workspace). While a feature is off, its sidebar entry shows a 'Locked' badge (or is hidden if you chose hide-instead-of-lock) and its routes are blocked. Enabling resumes instantly. The Agency Assistant can flip most gates for you (the email sending domain gate must be changed in the Manage dialog because disabling it tears down the live domain). If a sub-account is on a Client billing plan, that plan's gate bundle is applied automatically at activation and whenever the plan is edited — manual gate changes still work, but a plan edit re-applies the bundle.",
  },
  {
    id: "agency-client-billing",
    levels: ["agency"],
    title: "Client billing (plans & subscriptions)",
    location: "Agency → Client billing",
    keywords: ["billing", "charge", "plan", "subscription", "price", "stripe", "checkout", "invoice client", "mrr", "saas mode", "rebill", "comped", "special price", "paywall", "one-time charge", "one off", "quota", "included usage"],
    body:
      "Client billing lets you charge each sub-account a monthly subscription through your own Stripe account (payments land directly in your Stripe — the platform takes no cut). Create plans at Agency → Client billing: each plan is a name, a monthly price, the bundle of feature gates it unlocks, and optionally the monthly usage it includes (emails, SMS segments, WhatsApp, AI tokens, voice minutes — blank = unlimited) plus a per-unit overage rate for usage beyond the allowance (accrues as a dollar amount you can invoice with a one-time charge; see the Usage limits card). Assign a plan from that page's Clients table or from Agency → Sub-accounts → Manage → Billing: the workspace goes 'Awaiting payment' and you can copy or email a secure checkout link (re-sending invalidates older links); the client can also pay from an in-app activation screen. When they pay, the plan's features switch on automatically and renewals bill monthly. You can set a per-client special price, switch plans on a live subscription (prorated), or mark a client 'comped' (not billed — the default for every workspace, so nothing changes until you assign a plan). If a renewal fails the client sees a payment banner for a 7-day grace period, then the workspace pauses behind a paywall until they pay — data is never deleted. The Clients table shows each client's plan, status, and your MRR. You can also bill a client ONCE (e.g. 'Web design — $500') independent of any plan: create a one-time charge from the Manage dialog's Billing section (description + amount → a secure payment link to copy or email; it works for comped clients too). The Agency Assistant can drive billing by chat — list plans, create a plan, assign a plan to a sub-account, and create a one-time charge — each write behind its own confirmation card. Requires Stripe (secret key + webhook) configured on the deployment.",
  },
  {
    id: "payments",
    levels: ["sub-account", "agency"],
    title: "Payments (card payments via your own Stripe)",
    location: "Sidebar → Settings Sub-Account → Payments",
    keywords: ["payments", "stripe", "card", "connect stripe", "restricted key", "take payment", "deposit", "checkout", "pay button", "paypal"],
    body:
      "Payments lets a workspace take card payments from ITS OWN customers through its own Stripe account — money lands in the client's Stripe, not the agency's. A workspace admin connects it under Settings → Payments by pasting a restricted Stripe API key (no Stripe Connect involved). Once connected: invoices show a card 'Pay' button and mark themselves paid automatically, booking pages with a price can take the deposit by card, checkout pages can sell offers (with optional order bumps), and paid communities can charge for access. A Payments view under Reports summarizes what's been collected. The feature is agency-gated: if the Settings → Payments card isn't visible, the agency owner must enable Payments for this workspace (Agency → Sub-accounts → Manage). PayPal.me remains available as a simpler alternative for invoices (manual mark-paid).",
  },
  {
    id: "usage-limits",
    levels: ["sub-account", "agency"],
    title: "Usage limits & metering",
    location: "Agency → Sub-accounts → Manage → Usage",
    keywords: ["usage", "quota", "limit", "metering", "cap", "over quota", "monthly limit", "limit reached", "sms limit", "email limit", "ai tokens", "voice minutes", "paused", "skipped quota", "overage", "rate", "rebill"],
    body:
      "Usage metering tracks each workspace's monthly consumption of emails, SMS segments, WhatsApp messages, AI tokens, and voice minutes, and can cap them. Everything is unlimited until the agency owner sets limits — either on a Client billing plan (the plan editor's per-unit 'Included' fields apply to every client on that plan) or as a per-workspace override in the Manage dialog. Beside each included allowance the plan can also set an OVERAGE RATE — a per-unit dollar amount the agency charges for usage beyond the allowance; usage past the limit then shows as an accruing dollar amount in the Manage dialog's Usage section, which the owner can invoice with a one-time charge (automatic monthly overage billing is a later stage; rates are the agency's own sell prices, not provider costs). The agency owner sees each workspace's current usage, limits, and accruing overage in the Manage dialog's Usage section, and a 'Near/Over quota' badge on the Client billing table; they're emailed when a workspace passes 80% and 100% of any limit. When a limit is hit, that channel pauses for the workspace until the month resets: manual sends are refused with a 'monthly limit reached' message, workflow steps log 'skipped:quota', the AI agents stop replying on the capped channel (logged on the contact's timeline), and outbound AI calls are blocked before dialing. Inbound voice calls are still answered (minutes are counted but inbound is never cut off). If you're a workspace user seeing 'monthly limit reached', the limit was set by the platform owner — ask them to raise it or wait for the monthly reset.",
  },
  {
    id: "workspace-subscription",
    levels: ["sub-account"],
    title: "Your subscription (workspace billing)",
    location: "Sidebar → Settings → Your subscription",
    keywords: ["subscription", "billing", "payment", "card", "invoice", "paywall", "paused", "past due", "update card", "manage billing"],
    body:
      "If your provider bills this workspace as a subscription, Settings shows a 'Your subscription' card with your plan, monthly price, and status. Workspace admins can click 'Manage billing' to update the card or view invoices on Stripe's secure portal, and 'Complete checkout' if payment is still owed. If a renewal payment fails you'll see a warning banner with time to fix the card; after the grace period the workspace pauses behind a payment screen until it's paid — your data is safe and access restores instantly on payment. Pricing and plan changes are handled by your provider (the agency owner).",
  },
  {
    id: "agency-branding",
    levels: ["agency"],
    title: "Agency branding & settings",
    location: "Agency → Settings Agency",
    keywords: ["branding", "logo", "white label", "name", "settings", "billing", "subscription", "app icon", "pwa"],
    body:
      "Agency Settings is where you white-label the product: set the agency name and logo (shown across the sidebar and pages) and, for installable app deployments, the home-screen app icon. Billing (Stripe subscription) is managed here too. The public landing page's brand copy is set separately in the deployment's brand config.",
  },
  {
    id: "pwa-push-notifications",
    levels: ["sub-account", "agency"],
    title: "Mobile app & push notifications",
    location: "Top-right account menu → Your account → Notifications",
    keywords: ["push", "notifications", "notify", "alerts", "mobile app", "install", "pwa", "add to home screen", "home screen", "iphone", "ios", "android", "phone", "speed to lead", "new lead alert", "device", "turn on notifications"],
    body:
      "On installable (custom-branded) deployments the app can be added to a phone's home screen or installed on desktop, and you can turn on push notifications so you're alerted the moment a lead comes in. Notifications are per-user and per-device — each person enables them on each phone or computer they use. To turn them on, open the top-right account menu → Your account → Notifications, allow notifications when the browser prompts, then pick which sub-accounts should notify you. They arrive as that device's normal system notifications — a banner or lock-screen alert in the phone's notification tray, or the computer's notification centre — delivered by the browser even when the CRM isn't open; they are NOT messages that appear inside the CRM, and tapping one opens the app to the relevant item. Because they're per-device, each phone or computer you enable gets its own alert. You'll get a push for a new lead, a new inbound conversation message, a new booking, a missed call, and a quote or invoice being accepted or declined. iPhone and iPad only deliver web push to an app that's been added to the Home Screen (Share → Add to Home Screen), so on iOS install the app first, open it, then enable notifications from that page — the Notifications page shows this hint until you do. If it says notifications aren't configured, the deployment is missing its push keys — that's an agency-owner/setup task (set the VAPID keys NEXT_PUBLIC_VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY and redeploy). The home-screen app icon itself is set separately by the agency owner under Agency → Settings Agency.",
  },
  {
    id: "agency-members",
    levels: ["agency"],
    title: "Members & invites",
    location: "Agency → Sub-accounts → Manage → Members",
    keywords: ["member", "invite", "team", "role", "admin", "collaborator", "access", "remove"],
    body:
      "Add teammates to a sub-account by inviting them from its Manage → Members section. Roles: admin (manages members + settings, full read/write) and collaborator (read/write data, no member management). As agency owner you have implicit admin in every sub-account. Removing a member revokes their access immediately.",
  },
  {
    id: "agency-get-started",
    levels: ["agency"],
    title: "Get started / guided setup",
    location: "Agency → Get started",
    keywords: ["setup", "onboarding", "get started", "guided", "env", "keys", "configure"],
    body:
      "Get started is the first-run onboarding for the agency owner. There's also an optional Guided setup screen where you can enter remaining API keys in-app instead of editing environment variables by hand. Manual setup remains fully supported.",
  },
];
