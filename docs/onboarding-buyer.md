# Onboarding Guide (for Claude Code)

*Part of the [LeadStack CRM](../CLAUDE.md) docs.*

When the buyer asks you to help them set up this project, or if they seem new and haven't run the app yet, follow the procedure below. This is designed for buyers who may have never used a terminal before — they purchased LeadStack and just need it running. Start at **Phase 0** if they don't yet have their own copy of the repo open; otherwise begin at Phase 1.

## Phase 0: Make sure they're in their OWN repo (not the template)

The buyer is meant to work in a **private repository they generated from the LeadStack template** (`Claude-Code-Pro-Camp/leadstack-agency`), owned by their own GitHub account — NOT a direct clone of the template itself. This keeps their `origin` pointed at their account so their changes never flow back to the shared template, and matches the one-time-license model (their copy is standalone, no upstream link).

- **Invoked from an empty folder?** (The buyer pasted the "Set me up from the LeadStack template" bootstrap prompt from SETUP.md Phase 1.) Do this first:
  1. Ensure `git` + the GitHub CLI (`gh`) are installed; install whatever's missing (`winget install Git.Git GitHub.cli` on Windows, `brew install git gh` on Mac). Remind them to reopen the terminal so PATH updates.
  2. `gh auth login` — they complete the browser device-code step.
  3. `gh repo create <their-username>/my-crm --template Claude-Code-Pro-Camp/leadstack-agency --private --clone` — generates their own private copy and clones it. (`--template`, never a fork.)
  4. Open the new folder, then continue with Phase 1.
- **Project already open?** Confirm it's their copy, not the template: run `git remote -v` and check `origin` is `github.com/<their-username>/…`, NOT `Claude-Code-Pro-Camp/leadstack-agency`. If it points at the template, they cloned the wrong thing — have them generate their own repo (steps above) and reopen it before configuring anything.

**Support channel:** the only support path is the **Crisp chat bubble** on the buyer's purchase / thank-you page — there is no support email. If they're blocked on repo access (e.g. no GitHub invite yet), point them to the chat bubble.

## Phase 1: Check Prerequisites

Run these checks automatically and report what's installed vs missing:

1. `git --version` — need 2.30+
2. `node --version` — need 20+ (LTS; Node 18 is end-of-life)
3. `pnpm --version` — install with `npm install -g pnpm` if missing
4. `firebase --version` — install with `npm install -g firebase-tools` if missing
5. `stripe --version` — optional, install with `winget install Stripe.StripeCLI` (Windows) or `brew install stripe/stripe-cli/stripe` (Mac) for local webhook testing
6. `cloudflared --version` (or `ngrok --version`) — optional, only needed to test automations + the website builder locally. Install one of:
   - **Cloudflare Tunnel**: `winget install --id Cloudflare.cloudflared` (Windows) or `brew install cloudflared` (Mac)
   - **ngrok**: `winget install Ngrok.Ngrok` (Windows) or `brew install ngrok/ngrok/ngrok` (Mac)
   - Pick one — see Phase 3.5 for trade-offs. Skip entirely if the user only wants the core CRM.

After installing anything new, remind the user to close and reopen the terminal so PATH updates.

## Phase 2: Install Dependencies

1. Run `pnpm install` from the project root
2. Verify `node_modules` was created

## Phase 2.5: Brand the landing page

The landing page at `/` is a white-label CRM template. Before going further, edit [src/config/landing.ts](../src/config/landing.ts) and fill in `CUSTOM_BRAND`:

1. Ask the buyer:
   - Business name (used in navbar, hero, footer, page title — everywhere)
   - One-line tagline (used in hero subtitle + meta description)
   - Short description (~140 chars; goes under the hero headline)
   - Support email (used on CTA + FAQ + footer)
   - Primary domain (used in footer, og:url; no `https://`, no trailing slash)
   - Pricing tiers (Starter / Pro / Scale) — name, monthly + annual prices, blurb, feature bullets, CTA label, which one is highlighted

2. Write those into `CUSTOM_BRAND` in `src/config/landing.ts`.

3. Tell the buyer they can re-edit this file anytime — every section reads from `CUSTOM_BRAND` at build time.

If the buyer doesn't want to brand it yet, leave the placeholders in — the page still renders cleanly so they can verify the app boots — but call this out as a TODO before Vercel deploy.

## Phase 3: Configure Environment

> **Optional shortcut — in-app guided setup form.** Everything in this phase can
> be done by hand (the default, fully-supported path). As an *alternative* for
> the API-key-heavy part, the deployment ships an optional **Agency → Guided
> setup** screen (`/agency/setup`) where the agency owner types the remaining
> keys in-app and LeadStack writes them to Vercel (and, when you're running
> locally, your `.env.local`) then triggers a redeploy. See
> "Optional: in-app guided setup form" below for how to turn it on. It never
> replaces manual setup — use whichever you prefer, or mix both.

1. If `.env.local` does not exist, copy `.env.example` to `.env.local`.
2. Generate cookie secrets automatically and write them to `.env.local`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   Run twice — paste results into `COOKIE_SECRET_CURRENT` and `COOKIE_SECRET_PREVIOUS`.
3. Set `NEXT_PUBLIC_APP_URL=http://localhost:3000`.

Then walk through each external service. For each, explain what the user does in the browser and what values to paste back. Write values directly into `.env.local` as they're supplied.

### Firebase Client SDK
Tell the user:
> Go to https://console.firebase.google.com and create a project (or reuse one).
> Then Project Settings → Your apps → click the web icon (`</>`) and register a web app.
> You'll see a `firebaseConfig` object. Paste the whole object here and I'll extract the values.

When they paste, write into `.env.local`:
- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`

Then remind them to:
> Enable **Authentication → Sign-in method → Email/Password**.
> Create a **Firestore Database → Start in production mode** (our rules restrict access — test mode isn't needed).

### Firebase Admin SDK
> Firebase Console → Project Settings → Service accounts → **Generate new private key**. Open the JSON file it downloads and paste the contents here.

Extract and write:
- `FIREBASE_ADMIN_PROJECT_ID` ← from `project_id`
- `FIREBASE_ADMIN_CLIENT_EMAIL` ← from `client_email`
- `FIREBASE_ADMIN_PRIVATE_KEY` ← from `private_key`, wrapped in double quotes in the env file (keep `\n` escapes literal — Node's `replace(/\\n/g, '\n')` unwraps them at runtime).

**Treat the JSON as a secret.** Don't save it in the repo, don't paste it in chat logs that are shared. After you've extracted the three fields, delete the downloaded JSON.

### Deploy Firestore rules + indexes
`.firebaserc` is gitignored (per-developer project alias). On a fresh clone, point the Firebase CLI at the user's project once:
```bash
firebase login                     # only on first setup
firebase use <their-project-id>    # writes .firebaserc locally; do this once per clone
firebase deploy --only firestore:rules,firestore:indexes
```

Always deploy **both** in the same command. Rules and indexes live in separate files (`firestore.rules` and `firestore.indexes.json`) and are deployed separately by default — running `--only firestore:rules` alone silently skips indexes, and any feature that needs a compound query (`where X == ... where Y >= ...`) fails with `FAILED_PRECONDITION: The query requires an index` at runtime. The booking-availability endpoint is the most common trap; quotes + broadcasts can hit it too. Indexes take a few minutes to BUILD after deploy — visible at https://console.firebase.google.com/project/&lt;your-project&gt;/firestore/databases/-default-/indexes.

Re-run whenever you add a new collection, edit `firestore.rules`, or add an entry to `firestore.indexes.json`. `firebase.json` is committed and shared.

### Stripe
> Go to https://dashboard.stripe.com — make sure **Test mode** is ON (toggle top-right).
> Developers → API keys. Paste the publishable + secret keys here.

Write:
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_SECRET_KEY`

> Now create your product in Stripe. The shipped checkout helper references one price ID:
> - **Pro Plan** — a recurring price (any amount + interval that matches what the landing's Pro tier advertises). Used by the standard subscription checkout.
> Create whatever product + price matches the buyer's pricing model. Copy the Price ID (starts with `price_`) and paste here.

Write:
- `STRIPE_PRO_PRICE_ID`

The checkout helpers at `src/lib/stripe/checkout.ts` are easy to rewire once the buyer's pricing model is finalized (e.g. adding annual prices, multiple tiers, one-time fees).

Webhook secret (separate terminal):
```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```
Copy the `whsec_...` that prints on start. Write to:
- `STRIPE_WEBHOOK_SECRET`

### Resend (email)
> Go to https://resend.com, sign up, then **Domains → Add Domain**. Add DNS records to your domain's DNS provider, wait for verification (minutes to hours).
> Then **API Keys → Create API Key → Full access**. Paste the key here.

Write:
- `RESEND_API_KEY`
- `EMAIL_FROM` — must be on a verified domain. Example: `"LeadStack <notifications@yourdomain.com>"`.

If the user doesn't own a domain yet, they can still test with Resend's sandbox domain — `EMAIL_FROM="onboarding@resend.dev"` works for test sends but will be flagged as untrusted in production.

### Twilio (SMS)
> Go to https://console.twilio.com, sign up (free trial gives a phone number + credits).
> From the dashboard, copy **Account SID** and **Auth Token**.
> Under **Phone Numbers → Manage → Active Numbers**, copy your trial or purchased number in E.164 format (`+15551234567`).

Write:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`

**Trial-account caveats:** Twilio trial accounts can only send to verified phone numbers and prepend a "Sent from a Twilio trial account" banner. For real usage, upgrade the account and (in the US) register A2P 10DLC.

**Inbound webhook URL (required for STOP/START opt-out):**
Twilio needs to know where to POST when someone replies STOP. After Phase 3.5 (you'll have a public tunnel URL) or Phase 5 (you'll have a Vercel URL), come back here:
> Twilio Console → Phone Numbers → Manage → Active Numbers → click your number.
> Scroll to **Messaging Configuration** → **A MESSAGE COMES IN** → set the URL to `https://your-domain/api/webhooks/twilio/inbound` (HTTP POST). Save.

Without this, your code can still send SMS, but inbound STOP messages never reach the app and `contact.smsOptedOut` won't flip — meaning automations will keep texting people who opted out. Skip if you're not setting up automations.

### Upstash QStash (Automations + Website polling)
QStash is a managed message queue — it's how scheduled automation steps and website build polling survive Vercel cold starts. Without it, automations can't send delayed steps and website builds sit at "queued" forever.

> Go to https://console.upstash.com, sign up, then **QStash** → the **Quickstart** panel.

**Important — region matters.** The token is bound to a region (EU or US). The dashboard shows the matching URL endpoint above the token. Copy them together:

Write to `.env.local`:
- `QSTASH_URL` — the URL shown next to your token (e.g. `https://qstash.upstash.io` or the EU equivalent). The SDK doesn't auto-resolve this — wrong region = signature verification fails.
- `QSTASH_TOKEN` — from the same panel
- `QSTASH_CURRENT_SIGNING_KEY` — verifies inbound callbacks
- `QSTASH_NEXT_SIGNING_KEY` — for key rotation; needed even if not actively rotating

**Daily schedules are auto-registered on cold start** — no dashboard click needed. [instrumentation.ts](../instrumentation.ts) calls `ensureSchedulesRegistered()` which uses the QStash SDK's `schedules.create()` with stable `scheduleId`s, idempotent on every cold start. A 24-hour marker at `system/scheduleRegistration` skips the round-trip on hot starts so cold-start latency stays under 50ms.

Schedules registered automatically (declared in [src/lib/qstash/register-schedules.ts](../src/lib/qstash/register-schedules.ts)):

| scheduleId | Cron | Purpose |
|---|---|---|
| `leadstack-daily-housekeeping` | `0 3 * * *` | One schedule for every daily chore, run in sequence by `/api/cron/daily-housekeeping`: gitpage subscription status refresh, OpenRouter model-list refresh, the expired public-API logs / idempotency / webhook-event sweep (replaces Firestore native TTL so no console click needed), GBP review retention, and abandoned WhatsApp upload cleanup. Each job's own `/api/cron/*` route still works for a manual run. |

The QStash plan caps an account at **10 schedules**, which is why the daily chores share one. Registration also deletes the five schedules that preceded it (`leadstack-gitpage-heartbeat`, `-ai-models`, `-api-cleanup`, `-gbp-retention`, `-whatsapp-staging-cleanup`) before creating anything, so an account already at the cap is not blocked.

Auto-registration only fires when `NODE_ENV === "production"` AND `QSTASH_TOKEN` AND `NEXT_PUBLIC_APP_URL` are set. Local dev does nothing. If `NEXT_PUBLIC_APP_URL` changes (e.g. moving from a tunnel to Vercel), the marker is invalidated and the next cold start re-registers against the new URL. You can verify schedules landed by visiting the **Schedules** tab in the Upstash QStash dashboard after your first production deploy.

### Automations token secret
Used to HMAC-sign unsubscribe links so a malicious actor can't forge one and unsubscribe arbitrary contacts. Generate locally:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
Write to `.env.local`:
- `AUTOMATIONS_TOKEN_SECRET` — paste the output

If you ever rotate this, every existing unsubscribe link in inboxes becomes invalid — by design. Old recipients clicking will see a 404.

### gitpage.site (Website builder)
Each sub-account can publish a marketing site via gitpage.site. One agency-level API key powers all sub-accounts.

> Request your agency API key from gitpage.site (format `gp_<long hex>`).

Write to `.env.local`:
- `GITPAGE_API_KEY` — paste the key
- `GITPAGE_API_URL` — leave unset; the client defaults to `https://www.gitpage.site`. Override only if you're mocking the API locally.

gitpage rate-limits at **30 builds per hour per agency** (shared across all sub-accounts). The build route surfaces 429s as a friendly error to the operator.

### OpenRouter (AI Agents)
LeadStack uses OpenRouter as the LLM gateway — one key reaches every model (Claude, GPT, Gemini, etc.). Skip this entire section if the buyer doesn't plan to use the AI Agents feature; the rest of the CRM works without it.

> Go to [openrouter.ai](https://openrouter.ai), sign up, deposit at least $5 of credits (Web Chat + SMS bot replies at the Haiku default cost ~$0.005-0.02 per exchange, so $5 covers ~250-1000 conversations). Then **Keys** → **Create API Key**. Paste here.

Write to `.env.local`:
- `OPENROUTER_API_KEY` — paste the key
- `AI_REPLIES_DEFAULT_MODEL` — optional. Leave blank to use Claude Haiku 4.5 (recommended). Override per channel later if you want to test other models.

Without this, the AI Agents settings page still loads but channels stay silent — every channel toggle is rejected with a friendly "Set the persona first" message that's actually masking the missing key.

### Firecrawl (optional — powers AI Agent website KB)
Skip this if the buyer doesn't care about the bot referencing their clients' actual website content. The bot still works, it just falls back to "let me check with the team" for anything outside the persona prompt.

> Go to [firecrawl.dev](https://firecrawl.dev), sign up. The free tier covers a few hundred scrapes/month which is plenty since each sub-account only refreshes its KB on demand. Then **Dashboard** → **API Keys** → copy the `fc-…` key.

Write to `.env.local`:
- `FIRECRAWL_API_KEY` — paste the key. One agency-level key shared across all sub-accounts.

Once set, the AI Agents → Overview page exposes a "Refresh KB" button next to the website URL field. Clicking it scrapes the homepage (single-page, no crawl) and stores the markdown for the bot to reference.

### Vapi (optional — powers the AI Voice Agent channel)
Skip this entire section if the buyer isn't enabling voice yet. SMS + Web Chat agents work without it. Voice attaches to the sub-account's **existing dedicated Twilio number** via Vapi BYOC (or to a Vapi-managed number if the buyer wants to skip Twilio regulatory bundles — useful for AU clients in particular).

> Sign up at [vapi.ai](https://vapi.ai). Top up at least $10 of credits — voice agent calls run ~$0.10–0.15/min through Vapi (Deepgram STT + ElevenLabs TTS bundled). Then **API Keys** → copy the **Private Key** (NOT the Public Key — that's for browser widgets which we don't use).

Write to `.env.local`:
- `VAPI_API_KEY` — paste the Private Key. One agency-level key shared across all sub-accounts.
- `VAPI_WEBHOOK_SECRET` — anything you generate locally, e.g. `openssl rand -base64 32`. We embed this in the URLs we register with Vapi (`?s=<secret>`) and our `/api/webhooks/vapi/*` routes verify it on every callback. Rotating it later requires re-saving every active sub-account's voice channel so our provisioning code pushes the new value to Vapi.

**Critical prerequisite — `NEXT_PUBLIC_APP_URL` must be publicly reachable from Vapi.** Vapi POSTs our LLM webhook every voice turn (custom-LLM mode). Locally that means a cloudflared / ngrok tunnel; in prod set it to your Vercel domain.

Once both keys + the public URL are set, sub-account operators can go to **AI Agents → Voice** to enable the channel. Two phone number modes:
- **My dedicated Twilio number (BYOC)** — reuses the sub-account's Twilio creds (configured under Settings → SMS). One number serves SMS + Voice with one Twilio bill. Vapi auto-updates the Twilio voice URL via BYOC registration. Production path.
- **A number I own in Vapi** — operator pastes the UUID of a phone-number resource they've already provisioned in their Vapi dashboard. Skips AU regulatory bundles; great for testing and for buyers who'd rather pay Vapi directly. We bind a LeadStack-managed assistant to the operator's number (any previously-attached assistant on that number gets replaced).

On save, our provisioning code creates or updates a Vapi assistant named `LeadStack sa:<id>` with `custom-llm` mode pointing at our LLM webhook. Every voice turn flows: caller → Vapi (Deepgram) → POST to our webhook → `resolveAgent()` + `buildSystemPrompt({channelId:"voice"})` + OpenRouter (Claude Haiku 4.5 by default) → SSE stream back → Vapi (ElevenLabs) → caller. On hangup Vapi runs structured-data extraction (name / email / callbackRequested / reason) and POSTs an end-of-call webhook; our handler creates Contact + Task + escalation email + `subAccounts/{id}/voiceCalls/{callId}` summary doc.

Cost footprint: ~$0.10–0.15/min on Vapi + per-token OpenRouter charges on our existing key. Total comfortably under $0.20/min for a typical call.

**Outbound Voice uses the same Vapi setup — no extra keys.** Once Voice is provisioned, the agency owner can additionally turn on **Outbound Voice** (the AI proactively dialing contacts) for a sub-account. It's a separate agency gate (`outboundVoiceEnabledByAgency`, flipped from the agency's `/agency/sub-accounts` → Manage dialog) because it spends Vapi minutes proactively and carries dialing-compliance responsibility. After the gate is on, the sub-account operator enables it under **AI Agents → Outbound Voice** (a distinct outbound persona + first message + calling window + caps), then either clicks the call button on a contact or launches a bulk campaign over a filtered audience. Before any call is placed, LeadStack's **native compliance gate** checks the contact's `voiceOptedOut` flag, a per-call consent acknowledgment, the calling window in the contact's local timezone, and per-minute/daily/per-number caps — all enforced in-app with no third-party dependency (a pluggable scrub provider is a no-op until the buyer wires a regional DNC service). **No new env vars** — outbound reuses `VAPI_*`, `QSTASH_*` (campaign fan-out), the dedicated Twilio number, and `NEXT_PUBLIC_APP_URL`. Buyers in regulated markets should confirm their own calling-consent obligations before enabling it.

### Marketing tracking (Meta Pixel + GTM — optional)
Skip if the buyer doesn't run paid ads or doesn't care about analytics yet. Both vars are `NEXT_PUBLIC_*` so they're inlined at build time — changing them needs a redeploy.

> **Meta Pixel:** [Meta Events Manager](https://business.facebook.com/events_manager) → Data Sources → pick or create the Pixel → copy the numeric ID.
> **Google Tag Manager:** [tagmanager.google.com](https://tagmanager.google.com) → create a container → copy the `GTM-XXXXXXX` ID.

Write to `.env.local`:
- `NEXT_PUBLIC_META_PIXEL_ID` — numeric Pixel ID. When set, the Pixel loads on every page (landing + dashboard + hosted form pages) and form submissions auto-fire a `Lead` event client-side. UTM/fbclid/gclid/referrer/landing-page are stored on the contact regardless.
- `NEXT_PUBLIC_GTM_ID` — `GTM-XXXXXXX`. Use this as the escape hatch for any tracker Meta Pixel doesn't already cover (LinkedIn Insight, TikTok Pixel, Hotjar, custom server-side gtag, etc).

Both are fully optional and ship blank in `.env.example`. Once set, restart `pnpm dev` (env-var change requires a fresh boot in Next.js) — you should see the Pixel + GTM script tags in the page source.

### Live chat (Crisp — optional but recommended)
LeadStack is wired to route every "talk to us" path through the Crisp widget instead of `mailto:` (pricing checkout-error fallback, privacy-policy contact line). Without Crisp configured, those buttons silently no-op — there's no `mailto:` fallback.

> [app.crisp.chat](https://app.crisp.chat) → create a free account → Settings → Website Settings → Setup Instructions → copy the Website ID (a UUID).

Write to `.env.local`:
- `NEXT_PUBLIC_CRISP_WEBSITE_ID` — the UUID.

If the buyer doesn't want Crisp specifically, they can either pick a different chat widget (Intercom, Tawk.to — swap the script in [src/app/layout.tsx](../src/app/layout.tsx)) or replace `openCrispChat` calls in [src/lib/crisp.ts](../src/lib/crisp.ts) with a `mailto:` or contact-form route they actually monitor.

## Phase 3.5: Local dev tunnel for automations + website polling

QStash needs a public HTTPS URL to call back into your app — `localhost:3000` is unreachable from the public internet. Without a tunnel, automations and website polling won't fire locally. Skip this phase if you're only testing the core CRM (contacts, pipeline, forms without automations, etc.).

You have two options. Both end with you having an HTTPS URL like `https://something.trycloudflare.com` or `https://abc-123.ngrok-free.app`. **Set `NEXT_PUBLIC_APP_URL` in `.env.local` to that URL** — QStash uses it to build callback URLs and the website-poll route reads its own URL from it.

### Option A: Cloudflare Tunnel (recommended for the test loop)
- **Pros**: free, no signup needed for ad-hoc tunnels; named tunnels survive restarts so a single hostname can be saved into Twilio's webhook config and reused day after day.
- **Cons**: slightly more setup the first time.

Quick start (random hostname, rotates each run — fine for one-off testing):
```bash
cloudflared tunnel --url http://localhost:3000
```

Persistent named tunnel (recommended once you're past one-off testing):
```bash
cloudflared login                                # browser auth, one-time
cloudflared tunnel create leadstack-dev          # creates a tunnel ID
cloudflared tunnel route dns leadstack-dev leadstack-dev.YOUR-DOMAIN.com
cloudflared tunnel --name leadstack-dev --url http://localhost:3000
```
Re-run the last command anytime; the hostname stays the same.

### Option B: ngrok
- **Pros**: fastest first-run; no account needed for basic use.
- **Cons**: free-tier hostname rotates each restart. Every restart breaks Twilio's saved webhook URL and any QStash callbacks already in flight.

Quick start:
```bash
ngrok http 3000
```
Copy the `https://….ngrok-free.app` URL and paste it into `NEXT_PUBLIC_APP_URL`.

### After the tunnel is running
Update `.env.local`:
- `NEXT_PUBLIC_APP_URL=https://your-tunnel-hostname.example.com`

Then restart `pnpm dev` so the new value is picked up. Now go back to Twilio (Phase 3) and set the inbound webhook URL to `https://your-tunnel-hostname.example.com/api/webhooks/twilio/inbound`.

## Phase 4: Start the App

1. Run `pnpm dev`.
2. Open http://localhost:3000.
3. Walk through verification:
   - **Landing page** renders at `/` — confirm it shows the buyer's brand (`CUSTOM_BRAND.name` in the navbar + hero, their tagline, their pricing tiers). If you still see "LeadStack" anywhere, double-check that `CUSTOM_BRAND` was filled in at `src/config/landing.ts`.
   - **Theme toggle** switches light/dark.
   - **Signup** at `/signup` creates a user. Check Firebase Console → Authentication that the user appears.
   - **Dashboard** renders at `/dashboard` showing the "Getting Started" empty state.
   - **Add a contact** → it appears in `/contacts`.
   - **Open a deal** on that contact → drag it across pipeline stages.
   - **Create a calendar event** linked to the contact → check the timeline.
   - **Create a form** → copy the public link → submit it in an incognito tab → verify a new contact appears.
   - **Cmd/Ctrl + K** opens global search.
   - **Send email** from the contact profile (requires Resend vars). Verify inbox + blue "Email sent" activity.
   - **Send SMS** from the contact profile (requires Twilio vars). Verify phone + violet "SMS sent" activity.
   - **Upgrade** from `/#pricing` → Stripe checkout with test card `4242 4242 4242 4242`.
   - **Form auto-response** (proves QStash + automations work — needs the tunnel from Phase 3.5):
     - Sub-account → Forms → open or create a form → Automation panel → attach the **Speed-to-Lead** recipe with an SMS step + an email step containing `{{unsubscribeLink}}`.
     - Submit the form in an incognito tab using a real phone + email you can check.
     - SMS arrives within ~10s, email within ~30s. The email's "Unsubscribe" link should resolve and flip `contact.emailOptedOut = true`.
   - **Website build** (proves gitpage works — needs the tunnel from Phase 3.5):
     - Sub-account → Website → click **Sample** to prefill, then **Build site**.
     - Banner flips queued → building. Within 1–3 min you should see a green "Your site is live" banner with a `gitlab.io` or `github.io` URL.
   - **AI Agents → Web Chat** (proves OpenRouter + the widget pipeline work):
     - Sub-account → AI Agents → Overview → save the persona prompt (the default text is fine to start) and the business name. Optional: paste a website URL + click **Refresh KB** to confirm Firecrawl is wired.
     - Switch to the **Web Chat** tab → tick **Enable Web Chat** → set Allowed domains to `localhost` (for this local test) → **Save Web Chat settings**.
     - Copy the snippet and paste it into a tiny `test.html` file: `<html><body>Hello<script src="http://localhost:3000/widget.js" data-sa="..." async></script></body></html>`. Open it in a browser (`file://`) or serve via `python -m http.server 8080`. A bubble appears bottom-right; click → chat opens; send "can someone call me back" — within seconds you should see a real reply (proving OpenRouter works) and an inline form below it (proving the [[form]] marker pipeline works).
     - Fill the form → submit. Check Contacts (a new `source: "web-chat"` row), Tasks (a new "Follow up with…" row due today), and your inbox at the agent profile's escalation email (capture notification).
     - Sessions list lives at AI Agents → Web Chat → **Sessions** (top-right button).
   - **Quotes** (proves the quote → email → public-page → accept loop; uses Resend you already wired):
     - Sub-account → **Quotes** → **+ New quote** → pick a contact with a real email address you can check → fill 2-3 line items + a tax % + valid-until + terms → **Create draft**.
     - You land on the detail page with a `Q-2026-0001` number. Click **Send to recipient** — your real inbox should get a "Quote from {businessName}" email with a `View &amp; respond to quote` button.
     - Click the button in the email — you land on `/q/[token]` showing the quote. Click **Accept** — banner flips to "Quote accepted — thank you!" Back in the dashboard, the quote's status badge flips to Accepted and (because the default checkbox is on) a new Deal at the **Won** stage appears in the contact's Deals card with the quote total as value.
     - On the contact profile **Activity** column you should see a stack of new entries: `Quote sent`, `Quote opened by recipient`, `Quote accepted`, `Pipeline updated (auto)`.
     - Test the decline path on a second quote — the decline modal's reason picker writes the reason + note onto the quote, and the operator's detail-page timeline shows the reason.

## Phase 5: Deploy to Vercel (when ready)

1. Push to GitHub.
2. On https://vercel.com → Import repository.
3. Add **all** env vars from `.env.local` to Vercel → Project → Settings → Environment Variables. The full set:
   - Firebase client (`NEXT_PUBLIC_FIREBASE_*`) + admin (`FIREBASE_ADMIN_*`)
   - Cookie secrets (`COOKIE_SECRET_CURRENT`, `COOKIE_SECRET_PREVIOUS`)
   - `NEXT_PUBLIC_APP_URL`, `BOOTSTRAP_ADMIN_EMAIL`
   - Stripe (`STRIPE_*`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`)
   - Resend (`RESEND_API_KEY`, `EMAIL_FROM`) and Twilio (`TWILIO_*`)
   - QStash (`QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`) and `AUTOMATIONS_TOKEN_SECRET`
   - gitpage (`GITPAGE_API_KEY`, optionally `GITPAGE_API_URL`)
   - AI Agents: `OPENROUTER_API_KEY` (required for bot replies) + optional `AI_REPLIES_DEFAULT_MODEL`
   - AI Agents KB: optional `FIRECRAWL_API_KEY` (powers the "Refresh KB" button on the agent profile)
   - AI Voice Agent: optional `VAPI_API_KEY` + `VAPI_WEBHOOK_SECRET` (powers the AI Agents → Voice channel). Skip both if you're not enabling voice yet.
4. For `FIREBASE_ADMIN_PRIVATE_KEY`, paste the full key including the `-----BEGIN/END-----` markers. Vercel handles the newlines automatically.
5. Deploy.
6. Update the Stripe webhook endpoint (Stripe dashboard → Webhooks) to point to `https://your-domain.vercel.app/api/webhooks/stripe` and copy the new signing secret into Vercel env vars.
7. Update Twilio's inbound webhook URL (Console → Phone Numbers → Active Numbers → "A MESSAGE COMES IN") to `https://your-domain.vercel.app/api/webhooks/twilio/inbound`. The local-tunnel URL won't be reachable in production.
8. Update `NEXT_PUBLIC_APP_URL` in Vercel env vars to the production URL.
9. Redeploy.
10. **AI Agents Web Chat snippets:** any client sites where the buyer pasted the snippet during local testing point at `http://localhost:3000/widget.js` — those need to be updated to `https://your-domain.vercel.app/widget.js`. Also re-visit each sub-account → AI Agents → Web Chat and update **Allowed domains** to the real hostnames of each client's production site (not `localhost`).
11. **AI Voice Agent:** if any sub-account had Voice enabled during local testing, the linked Vapi assistant has the **cloudflared tunnel URL** baked in for `model.url` + `server.url`. Open each sub-account's AI Agents → Voice and click **Save voice settings** — that re-PATCHes the Vapi assistant with the production `NEXT_PUBLIC_APP_URL`. Without this, calls would still hit the now-dead tunnel and Vapi would log `getaddrinfo ENOTFOUND` errors. The `VAPI_WEBHOOK_SECRET` value in Vercel **must match** the one used locally so previously-provisioned assistants keep authing correctly.

## Troubleshooting Tips

Common issues and fixes:
- **pnpm not found** — `npm install -g pnpm`, restart terminal.
- **Wrong directory** — make sure you're in the folder with `package.json`.
- **Blank page / 500 errors** — `.env.local` likely has a missing or malformed value. Read it; look for empty keys.
- **Auth not working** — in Firebase Console confirm Email/Password provider is enabled.
- **"Permission denied" in Firestore** — `firebase deploy --only firestore:rules,firestore:indexes` wasn't run, or `.firebaserc` points to the wrong project.
- **Port 3000 in use** — `pnpm dev -- -p 3001`.
- **Private key issues** — `FIREBASE_ADMIN_PRIVATE_KEY` must be in double quotes, with literal `\n` escapes (not real newlines).
- **Stripe webhook not firing** — `stripe listen` needs to be running in a second terminal for local testing.
- **Resend 403 at send time** — the `EMAIL_FROM` address is on a domain that isn't verified in Resend. Check Resend → Domains.
- **Twilio "unverified number" error** — trial accounts can only SMS phones you've verified in Twilio → Phone Numbers → Verified Caller IDs.
- **Comms buttons disabled** — contact has no email or no phone. Edit the contact, add the field, save.
- **Cmd+K doesn't open** — make sure you're on a `/dashboard` / `/contacts` / etc. page (not the public landing page).
- **Form submit succeeds but no SMS/email auto-response** — QStash isn't configured, signing keys mismatch the region, or `NEXT_PUBLIC_APP_URL` doesn't match the public tunnel. Check Vercel/local logs for `/api/automations/step` returning 503 or 401, and verify `QSTASH_URL` matches the region of `QSTASH_TOKEN`.
- **Unsubscribe link returns 404** — `AUTOMATIONS_TOKEN_SECRET` was rotated; old links are invalidated by design. The user has to receive a new email; old ones can't be revived.
- **Twilio STOP not flipping `smsOptedOut`** — Twilio's "A MESSAGE COMES IN" webhook URL isn't pointing at `/api/webhooks/twilio/inbound`, or it points at a stale tunnel hostname after a restart. Refresh the URL in the Twilio console.
- **Website build hangs at "queued"** — the QStash callback can't reach your app. Check `NEXT_PUBLIC_APP_URL` matches the tunnel/Vercel domain, and that the QStash dashboard shows the poll messages with `DELIVERED` status.
- **Website build "ready" but no live URL in the UI** — Firestore rules for the website subcollection weren't deployed. Run `firebase deploy --only firestore:rules,firestore:indexes`.
- **Public booking page renders but availability fails with "Couldn't load availability" / 500** — almost always a missing Firestore composite index in production. The availability endpoint runs `where("subAccountId", "==", X).where("startAt", ">=", Y).where("startAt", "<=", Z)`, which requires the `events(subAccountId, startAt)` composite index declared in `firestore.indexes.json`. Indexes deploy separately from rules — run `firebase deploy --only firestore:rules,firestore:indexes` (both flags). Indexes take a few minutes to BUILD after deploy; watch progress in the Firebase Console → Firestore → Indexes tab. Vercel logs for `/api/booking/[saId]/[slug]/availability` will show `[booking/availability] events query failed sa=... slug=... requires an index` when this is the cause.
- **Every Public API request returns 500 `internal_error` (even with a valid key)** — missing Firestore indexes on a fresh Firebase project. API-key auth runs a `collectionGroup("apiKeys").where("prefix", "==", …)` query that needs the `apiKeys.prefix` COLLECTION_GROUP field override, and each `/api/v1/*` list endpoint (contacts / deals / tasks / events) needs its `(subAccountId, mode, <sort field>)` composite — all declared in `firestore.indexes.json`. Run `firebase deploy --only firestore:rules,firestore:indexes` and wait for the indexes to finish BUILDING (Firebase Console → Firestore → Indexes). The generic 500 is deliberate (the API never leaks internals); the real `FAILED_PRECONDITION` error is in Vercel logs under `[api/v1] handler threw`.
- **ngrok hostname keeps rotating** — switch to a named cloudflared tunnel (Phase 3.5 Option A), or upgrade ngrok to a paid plan with a reserved domain.
- **AI Agents channel toggle won't enable** — "Set the persona first" error means `aiAgent/profile.systemPrompt` is empty for that sub-account. Open AI Agents → Overview, fill in the persona prompt (or leave the pre-filled default), click Save profile, then retry the channel toggle.
- **Web Chat widget doesn't render on the client's site** — likely the parent-page hostname isn't in the channel's `webChat.allowedDomains`. The widget loader receives `{enabled: false}` from `/api/web-chat/config` and silently no-ops. Check the browser console for the config response and add the missing hostname under AI Agents → Web Chat → Allowed domains.
- **Web Chat returns "I had trouble reaching the server"** — most often `OPENROUTER_API_KEY` is missing or out of credits; server logs show `[web-chat/respond] LLM call failed`. Also possible: rate limit hit (60/IP/hour or 30/session) — logs return 429 with a Retry-After header.
- **Refresh KB button returns 503** — `FIRECRAWL_API_KEY` isn't set on the deployment. The KB is optional; either set the key or live without site-aware bot context.
- **Refresh KB returns 502 with a Firecrawl error** — usually the URL is paywalled, behind Cloudflare anti-bot, or returned a 404. Try a simpler URL (the bare domain root) or check the site is publicly accessible without JS.
- **Captured a Web Chat lead but no follow-up email arrived** — the agent profile's `escalationNotifyEmail` is blank (or Resend isn't configured). The Task still creates, only the email is skipped. Set the email on AI Agents → Overview → "Default escalation email" or use the per-channel override.
- **Inline capture form doesn't appear after asking for details** — the bot didn't emit the `[[form fields="…"]]` marker. Open AI Agents → Overview → "Test this persona" and ask the same question — if the marker doesn't appear in your test reply, the persona prompt may be overriding the safety-rail instructions (e.g. "always be concise" can suppress markers). Tweak the persona to not contradict the lead-capture instructions.
- **Voice channel enable returns 503 "Vapi isn't configured"** — `VAPI_API_KEY` or `VAPI_WEBHOOK_SECRET` missing on the deployment. Set both, redeploy (Vercel doesn't hot-reload env vars), retry the save.
- **Voice channel enable returns 400 "Configure your dedicated Twilio number first"** — BYOC mode requires the sub-account's `twilioConfig.enabled === true`. Either configure Settings → SMS first, or switch the Voice phone-number source to "A number I own in Vapi" + paste a Vapi phone-number UUID.
- **Voice channel enable returns 400 "Paste your Vapi phone number ID"** — vapi-managed mode requires the operator to paste the UUID of a phone-number resource they've already created in their Vapi dashboard. Find it under Vapi → Phone Numbers → click the number → the UUID is shown directly under the +1/+61 number.
- **Voice channel saved but call rings and drops with `error-providerfault-custom-llm-llm-failed`** — Vapi can't reach our LLM endpoint. Check Vercel logs filtered to `/api/webhooks/vapi/llm/` — if you see 401, the assistant has a stale `VAPI_WEBHOOK_SECRET` baked into the URL; re-save voice settings to push the current value. If you see 404 / DNS errors, `NEXT_PUBLIC_APP_URL` is wrong on Vercel.
- **Voice call connects, greeting plays, but bot stays silent on every reply** — Vapi expects an SSE stream from custom-LLM. Our route already streams (see `openAiSseStream` in the LLM route); if you see this symptom on a fork or after refactor, confirm the LLM route returns `Content-Type: text/event-stream` with `data: …` chunks, not non-streaming JSON.
- **Voice bot speaks the `[[capture]]` marker syntax out loud** — the LLM route's `stripVoiceUnspeakables()` should be removing markers + asterisks before SSE-streaming. If markers leak through, check whether the voice safety rails in `prompt.ts` accidentally instruct the model to emit a marker — they shouldn't, voice relies on Vapi's `analysisPlan.structuredDataPlan` post-call extraction instead.
- **Voice call ends but no Task / Contact / voiceCalls doc created** — Vapi didn't send the end-of-call-report webhook. Check the Vapi call's logs panel for `category: "webhook" messageType: "end-of-call-report"`. If absent, the assistant's `serverMessages` list is missing `end-of-call-report` — re-save voice settings to push the explicit list (`["end-of-call-report", "status-update", "hang"]`) to Vapi.
- **Voice calls page shows "No calls yet" but Tasks exist** — Firestore rules for the `voiceCalls` subcollection weren't deployed. Run `firebase deploy --only firestore:rules,firestore:indexes`. The Firestore client SDK swallows permission-denied errors and renders the empty state.
- **Vapi assistant shows "Unsaved changes — publish to apply" after every PATCH** — our provisioning sets `analysisPlan.structuredDataPlan.messages` + `server.timeoutSeconds` explicitly to avoid this. If the banner reappears, re-save voice settings; one of those fields drifted on Vapi's side and our PATCH re-anchors them.
- **Quotes "Send" returns 503** — `RESEND_API_KEY` or `EMAIL_FROM` isn't set on the deployment. The Quotes builder still works locally (drafts save fine), only the send is gated. Configure Resend then retry — quote stays in draft state, click Send again.
- **Public /q/[token] page returns 404** — three things to check, in order. (1) Token is malformed or expired (operator may have re-sent, invalidating this link). (2) `firestore.rules` hasn't deployed since adding the `quotes/{id}` block — run `firebase deploy --only firestore:rules,firestore:indexes`. (3) `AUTOMATIONS_TOKEN_SECRET` was rotated since the email was sent (rotation invalidates every outstanding token by design). Solution: operator re-sends from the quote detail page to mint a fresh token.
- **Quote accepted but no Deal appeared at "Won"** — either `autoCreateDealOnAccept` was unchecked on the quote (it's per-quote, default on), or the deal write blipped (logged but not surfaced to the recipient — they see "accepted" regardless). Check the contact's pipeline column manually. Operator can create the deal by hand if it's missing — no automated retry in v1.
- **Quote-triggered automation never fires sends** — known v1 limitation. The trigger types (`quote_sent`, `quote_accepted`, etc.) dispatch correctly into `fireTriggers()` and create the execution doc, but the only `recipeType` shipped is `instant_response` which only handles `form_submit` in `computeFirstStepDelay()`. v2 will either extend instant-response or add a quote-aware recipe. For now, hand-wired automations via direct Firestore edit will register but never send.
- **Firestore "INTERNAL ASSERTION FAILED (ca9)" in browser console** — the `quotes/{id}` rules block is missing from `firestore.rules` (or wasn't deployed). The Firestore client SDK's onSnapshot stream gets denied and surfaces this opaque error. Run `firebase deploy --only firestore:rules,firestore:indexes` to fix.

