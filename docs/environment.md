# Environment Variables

*Part of the [LeadStack CRM](../CLAUDE.md) docs.*

Every single credential is user-provided. Nothing ships embedded. Store in `.env.local` (local) or Vercel env vars (production). See `.env.example` for the template.

## Required for the app to boot
| Var | Source |
|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase Console → Project Settings → Web app config |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | same |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | same |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | same |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | same |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | same |
| `FIREBASE_ADMIN_PROJECT_ID` | Firebase Console → Project Settings → Service accounts → Generate key (JSON) |
| `FIREBASE_ADMIN_CLIENT_EMAIL` | from service account JSON |
| `FIREBASE_ADMIN_PRIVATE_KEY` | from service account JSON (keep as single-line with `\n` escapes, wrapped in double quotes) |
| `COOKIE_SECRET_CURRENT` | `openssl rand -base64 32` |
| `COOKIE_SECRET_PREVIOUS` | same (different value) |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` locally, your production URL in prod |
| `BOOTSTRAP_ADMIN_EMAIL` | The email that's allowed to claim the workspace admin slot on the first signup. Set this BEFORE deploying — while the workspace is unclaimed and this is unset, every signup is refused. Once an admin exists, the var is ignored. |

## Required for billing
| Var | Source |
|---|---|
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe Dashboard → Developers → API keys (test mode for dev) |
| `STRIPE_SECRET_KEY` | same |
| `STRIPE_WEBHOOK_SECRET` | `stripe listen --forward-to localhost:3000/api/webhooks/stripe` prints this |
| `STRIPE_PRO_PRICE_ID` | Stripe Dashboard → Product catalog → create your recurring "Pro" price, copy the `price_...` ID |

## Optional — Paystack (the Client Billing rail for South African agencies)
| Var | Source |
|---|---|
| `PAYSTACK_SECRET_KEY` | [dashboard.paystack.com](https://dashboard.paystack.com) → Settings → API Keys & Webhooks → Secret Key. |
| `BILLING_PROVIDER` | Optional, `stripe` \| `paystack`. Only needed while a deployment holds BOTH secrets at once. |

Stripe will not onboard a South African entity for SaaS-mode rebilling, so **Client Billing**
(agency → sub-account) can run on Paystack instead — `PaystackBillingProvider`, the second
implementation of the `BillingProvider` interface. This is Client Billing ONLY; **Payments v1**
(a sub-account charging its own customers with its own restricted key) is a separate integration
and still Stripe.

**Selecting Paystack takes an explicit `BILLING_PROVIDER=paystack`** — holding a
`PAYSTACK_SECRET_KEY` is deliberately not enough. Inferring the rail from key presence would mean
pasting a key silently moves live billing onto a rail whose webhook receiver does not exist, where
a client's payment lands and their workspace stays walled. A deployment that sets only the key
keeps Stripe's "billing isn't configured" path, which is loud and harmless.

**A plan switch reads its timing from the provider** (`BillingProvider.planSwitchTiming`) rather
than the call site choosing, and `switchSubscriptionPlan` returns the subscription id that is live
AFTER the switch, which the caller persists. Stripe mutates in place and returns the same id;
Paystack cannot, so it cancels one subscription and opens another with a new code. Storing the
stale id would make a later cancel disable a dead subscription while the live one kept charging
the client.

**Three behaviours differ from Stripe, by necessity:** plan switches apply at the **renewal date**
(Paystack cannot prorate, so a mid-cycle switch is refused rather than silently mispriced); plans
must be priced in a currency Paystack settles (**ZAR** here — a USD plan is refused at create
time); and there is **no billing portal** — "Update card" opens Paystack's per-subscription manage
page. A Paystack Plan *is* the price, so a plan rename reaches Paystack only when a price is next
minted, and retiring a price is a no-op (a plan code can only reach checkout by being stored on
the plan doc, which the caller has just overwritten).

**The webhook receiver is `/api/webhooks/paystack`** (public path — Paystack signs every event
with HMAC-SHA512 of the raw body keyed on the **account secret key**, so there is no separate
webhook secret). Register the URL at dashboard.paystack.com → Settings → API Keys & Webhooks.

Both rails share ONE lifecycle, in [src/lib/server/billing-lifecycle.ts](../src/lib/server/billing-lifecycle.ts):
`activateSubAccountPlan`, `applySubAccountSubscriptionStatus`, `recordSubAccountSubscriptionId`
and `markSubAccountChargePaid` are provider-neutral, and each provider's handlers are thin
adapters onto them. `billing-service.ts` keeps the operator-driven half (creating plans, assigning
them, minting checkout links) and re-exports the lifecycle for existing callers. Activation, the gate bundle, the dunning grace window, the audit row
and the outbound webhook therefore cannot drift between Stripe and Paystack.

**Two Paystack shapes drive the router:** a payment and its subscription arrive as *separate*
events in no guaranteed order (`charge.success` carries our metadata but no subscription code;
`subscription.create` carries the code but none of our metadata), joined on the customer code
stored before checkout opened — and **renewals carry no metadata at all**, so they are recognised
by the absence of a `kind` and resolved by customer. A renewal names a PLAN code, never a
subscription code; the router deliberately leaves the subscription id unknown rather than storing
one as the other.

**A renewal must prove it is one.** `charge.success` fires for EVERY successful charge on the
agency's Paystack account, so a metadata-less charge is only treated as a renewal when it carries
a plan code AND that plan is the one the workspace is subscribed to (`matchPriceId` on the shared
handler). Otherwise a lapsed client paying the agency for something else — or a dashboard test
charge under the same customer — would clear their dunning window and unlock an unpaid plan.

**`subscription.not_renew` does NOT cancel.** It means auto-renew was switched off; the
subscription is "active, non-renewing" and the paid period runs to its end date.
`subscription.disable` is the terminating event. Cancelling on `not_renew` would paywall someone
for weeks they had paid for — and Stripe's `cancel_at_period_end` correctly reports nothing until
the period ends.

## Required for email (disables cleanly if missing)
| Var | Source |
|---|---|
| `RESEND_API_KEY` | [resend.com](https://resend.com) → API Keys |
| `EMAIL_FROM` | A sender on a Resend-verified domain, e.g. `"LeadStack <notifications@yourdomain.com>"` |

Without these two vars, `/api/comms/email/send` returns **503** and the Email button in the contact profile still renders but the send fails cleanly.

## Optional — system mail mailbox (password resets)
| Var | Source |
|---|---|
| `PLATFORM_SMTP_HOST` | Your mail host, e.g. `mail.yourdomain.com` |
| `PLATFORM_SMTP_PORT` | `465` (TLS, default) or `587` / `2525` (STARTTLS) |
| `PLATFORM_SMTP_USER` | Mailbox login, e.g. `noreply@yourdomain.com` |
| `PLATFORM_SMTP_PASS` | Mailbox password |
| `PLATFORM_SMTP_FROM` | Sender address, normally the same mailbox |

With all of these set (plus `NEXT_PUBLIC_APP_URL`), "Forgot password?" sends a branded reset
mail from this mailbox whose link opens `/login` on your own domain. Without them it falls back
to Firebase's built-in mail, which links to `<project>.firebaseapp.com` — spam filters score
that link as phishing, so expect those mails in spam.

## Required for SMS (disables cleanly if missing)
| Var | Source |
|---|---|
| `TWILIO_ACCOUNT_SID` | [console.twilio.com](https://console.twilio.com) dashboard |
| `TWILIO_AUTH_TOKEN` | same |
| `TWILIO_FROM_NUMBER` | A phone number owned by the Twilio account (trial or purchased) |

Without these three, `/api/comms/sms/send` returns 503. SMS opt-out (STOP/START) also requires the inbound webhook URL configured on the Twilio number — see the Onboarding Guide below.

**Dev/CI only — never set on production** (the deploy guard refuses any mention of these names, exactly as for `GBP_PROVIDER` / `WHATSAPP_SETTINGS_PROVIDER`):

| Var | Purpose |
|---|---|
| `SMS_PROVIDER` | `fake` swaps Twilio for a deterministic fake at the ONE seam `sendSmsForSubAccount` uses to place a send (`src/lib/comms/sms/select.ts`) — every SMS path (missed-call text-back, workflows, manual send) benefits, and returns a deterministic `sid` recording nothing else, save for one magic failing number (`+15005550001`) that always throws. Unset/anything else = real Twilio. Honoured only when `NEXT_PUBLIC_APP_URL`'s host is exactly `127.0.0.1`, `localhost` or `[::1]`; otherwise the send throws `SmsFakeRefusedError` rather than falling back. |
| `SMS_FAKE_ALLOW_PROD_BUILD` | `1` lets the fake run in a `NODE_ENV=production` build — needed only because CI's Playwright job boots the production bundle on 127.0.0.1. Any other value refuses. |
| `SMS_FAKE_AGENCY_ID` | Required with `SMS_PROVIDER=fake`: the fake sends only for sub-accounts of this agency (set it to the E2E fixture agency). Local dev and CI use the production Firestore, so this is what stops a fake send silently no-op-ing for a real tenant's SMS. |

## Required for automations (disables cleanly if missing)
| Var | Source |
|---|---|
| `QSTASH_URL` | [console.upstash.com](https://console.upstash.com) → QStash → Quickstart panel. **Region-specific** — copy the URL shown for your token's region (EU vs US). Wrong region = signature failures. |
| `QSTASH_TOKEN` | same panel |
| `QSTASH_CURRENT_SIGNING_KEY` | same panel — verifies inbound `Upstash-Signature` headers |
| `QSTASH_NEXT_SIGNING_KEY` | same panel — used during key rotation |
| `QSTASH_LEGACY_CURRENT_SIGNING_KEY` / `QSTASH_LEGACY_NEXT_SIGNING_KEY` | Optional. After moving to another QStash account, the OLD account's two signing keys, so its still-queued delayed deliveries keep verifying. Both or neither. Remove once those have drained (max ~7 days). |
| `AUTOMATIONS_TOKEN_SECRET` | `openssl rand -base64 32`. HMAC-signs unsubscribe links so they can't be forged — and the tracked review links (`/rr/…`) sent while review-request reminders are on, and the Web Voice widget and call tokens (must be at least 16 characters for those, or the mic stays hidden). Rotating this invalidates all outstanding unsubscribe and tracked review links; open widgets hide their mic until the page reloads. |

Without these, `/api/automations/step` and the website-builder poll route return 503. Automation triggers still fire on form submit (the `automation_executions` row gets created) but step 0 never executes — the form submission itself still works.

## Required for website builder (disables cleanly if missing)
| Var | Source |
|---|---|
| `GITPAGE_API_KEY` | gitpage.site dashboard — agency-level key, format `gp_…`. Shared across all sub-accounts in this deployment. |
| `GITPAGE_API_URL` | Optional. Defaults to `https://www.gitpage.site`. Override only when mocking locally. |

Without `GITPAGE_API_KEY`, `/api/sub-accounts/[id]/website/[siteId]/build` returns 503 and the **Build site** button surfaces a friendly error. The rest of the Website page (adding sites, form editing) still loads. The same key verifies gitpage's `build.settled` callback (`POST /api/webhooks/gitpage/build-settled`, HMAC-SHA256 of the raw body); that route also answers 503 without it.

## Required for AI Agents (disables cleanly if missing)
| Var | Source |
|---|---|
| `OPENROUTER_API_KEY` | [openrouter.ai](https://openrouter.ai) → Keys. One agency-level key covers every model (Anthropic, OpenAI, Google, etc). Required to power the bot replies on Web Chat + SMS channels. |
| `AI_REPLIES_DEFAULT_MODEL` | Optional. OpenRouter model id used when no per-channel override is set. Defaults to `anthropic/claude-haiku-4-5` (best cost/quality balance for SMS-length replies). Override per channel to use `anthropic/claude-opus-4-7` for premium tiers (~50x cost). |

Without `OPENROUTER_API_KEY`, the AI Agents settings UI still renders but every channel stays silent: the SMS inbound webhook short-circuits past `maybeRespondWithAi`, the Web Chat `/api/web-chat/message` endpoint returns the fallback "I had trouble reaching the server" reply, and the `/api/sub-accounts/[id]/ai-agent/test` endpoint returns 503.

## Optional — wa-manager (self-serve WhatsApp bridge provisioning)
| Var | Source |
|---|---|
| `WA_MANAGER_BASE_URL` | The wa-manager listener, e.g. `http://127.0.0.1:33000`. It binds to loopback on the CRM's own box and stays there — it is never exposed publicly, because every one of its routes is privileged. |
| `WA_MANAGER_OPERATOR_TOKEN` | `OPERATOR_TOKEN` from the manager's own `.env` on that box. |

CrestaHQ operates the bridge as a service: `wa-manager` runs one
`wa-agent-bridge` process per sub-account and holds the credentials for all of
them. **The operator token has no notion of tenant ownership** — it can link a
WhatsApp device on any tenant on the box — so the CRM, not the manager, is the
tenancy boundary: every route under
`/api/sub-accounts/[id]/whatsapp-bridge/*` derives the manager tenant id from
the authenticated session's sub-account and never from the request.

Without these, nothing 500s and no page breaks: the self-serve provision /
pairing / restart / disconnect routes answer 503 with a sentence saying the
manager isn't configured, and a bridge can still be connected by hand through
`/api/sub-accounts/[id]/whatsapp-bridge-connection` with credentials read off
the box. A buyer copy deploying to Vercel has no manager and never sets these.

Note there is no rotation route by design. The manager returns the bridge's app
token and webhook secret exactly once, in the 201 of the provision call, and
keeps no readable copy. If the CRM loses them the recovery is
disconnect-and-reprovision, which erases the WhatsApp session and costs the
customer a re-pair.

## Optional — Firecrawl (powers the website KB on the AI Agent profile)
| Var | Source |
|---|---|
| `FIRECRAWL_API_KEY` | [firecrawl.dev](https://firecrawl.dev) → Dashboard → API Keys, format `fc_…`. One agency-level key shared across all sub-accounts. |

Without this, the AI Agents → Overview page still renders and the agent still works — but the "Refresh KB" button under the website URL field returns 503 with a friendly message. Without a KB the bot can't answer factual questions about the client's services/pricing/etc; it falls back to "let me check with the team and get back to you" for anything outside the persona prompt.

Single-page scrape only (`/v1/scrape` endpoint). The bot's stored snapshot is capped at 6000 chars (~1500 tokens) so it doesn't bloat the prompt on every reply. Re-crawl on demand; stale KB is cleared automatically whenever the operator changes the website URL.

## Optional — Google Places (powers the EXPERIMENTAL Get Leads feature)
| Var | Source |
|---|---|
| `GOOGLE_PLACES_API_KEY` | Google Cloud console → enable **Places API (New)** and the **Geocoding API** → Credentials → Create API key → restrict it to those two APIs (`places.googleapis.com` + `geocoding-backend.googleapis.com`) — a Places-only restriction makes typed-town searches fail with 502. Server-only. Text Search is free up to 1,000 calls a month at the field mask Get Leads uses; set a daily SearchText quota on the project (ours is 30/day) so a busy day can't run past the free tier. One agency-level key shared across all sub-accounts. |

See [Get Leads](features/get-leads.md). Without this key, the Get Leads page still renders (for gated-on sub-accounts) but searches return 503 with a friendly "not configured" message. When the project's daily quota is spent, searches return 429 "Daily search limit reached — try again tomorrow." Typed locations are geocoded server-side with this same key, so the project also needs the **Geocoding API** enabled (free monthly allowance covers this volume; set a daily cap — ours is 100/day — and a spent cap returns 429 "Daily location lookup limit reached"). `NEXT_PUBLIC_MAPBOX_TOKEN` is **optional** here: it only adds the results **map tab** and location autocomplete (same token as the dashboard Leads map — the list tab, typed towns and "Use my location" all work without it). The feature is also **off by default per sub-account** — flip the Get Leads gate in `/agency/sub-accounts` → Manage.

## Optional — Vapi (powers the AI Voice Agent channel — inbound + Outbound Voice)
| Var | Source |
|---|---|
| `VAPI_API_KEY` | [vapi.ai](https://vapi.ai) → Dashboard → API Keys. Private agency-level key. |
| `VAPI_WEBHOOK_SECRET` | `openssl rand -base64 32`. We send it to Vapi on each assistant create/update so Vapi attaches it as `Authorization: Bearer <secret>` on every callback to us. Rotating it requires re-saving every voice channel so the new value pushes to Vapi. |

Without these, the AI Agents → Voice settings page still renders but the Enable toggle returns 503 with a friendly "Vapi isn't configured on this deployment" error. The shared persona/KB on the Overview, SMS, and Web Chat channels are unaffected.

Voice attaches to the sub-account's **existing dedicated Twilio number** via Vapi BYOC (bring-your-own-carrier) — one number serves SMS + Voice with one bill. Configure Twilio under Settings → SMS first; the Voice settings page surfaces an amber banner until that's done. `NEXT_PUBLIC_APP_URL` must be set and publicly reachable (Vapi POSTs the LLM webhook on every voice turn) — locally that means cloudflared/ngrok per the Phase 3.5 tunnel guide.

Cost footprint: Vapi bills per-minute (model + STT + TTS bundled, roughly 7-15¢/min at Haiku + ElevenLabs); OpenRouter bills per-token on top via our existing `OPENROUTER_API_KEY`. Each turn token cost is logged into the channel's `totalTokensUsed` counter the same way SMS/Web Chat tracks usage.

## Optional — Meta (Facebook/Instagram inbox + Social Planner)
One Meta app powers BOTH the FB Messenger / IG DM inbox AND the Social Planner (they share one connection). All optional — leave unset and both features stay off.

| Var | Source |
|---|---|
| `META_APP_ID` | [developers.facebook.com](https://developers.facebook.com) → your app → Settings → Basic. |
| `META_APP_SECRET` | Same page. Keep secret. |
| `META_WEBHOOK_VERIFY_TOKEN` | Any string you choose; enter the same value in the Meta app's Webhooks config. Needed for inbound inbox messages (not for posting). |
| `WHATSAPP_APP_SECRET` | Optional. The app secret of a separate Meta app used for WhatsApp Cloud — e.g. one in the business portfolio that owns the WABAs. The `/api/webhooks/whatsapp-cloud` webhook accepts a signature from this app or from `META_APP_SECRET`'s. Its webhook uses the same `META_WEBHOOK_VERIFY_TOKEN`. |

**Gray-out behavior:** when `META_APP_ID` + `META_APP_SECRET` are absent, `metaAppConfigured()` is false, so the **"Facebook + Instagram inbox"** and **"Social Planner"** toggles in the agency Manage dialog are **disabled/grayed out** (with a "set META_APP_ID / META_APP_SECRET" hint), and the feature-gates PATCH route refuses to enable either gate (400). The client reads this via `GET /api/agency/deployment-config` (returns `{ metaConfigured }` — non-sensitive booleans only). An already-enabled gate can still be turned OFF so a legacy state isn't trapped. Derives from the two secrets — there is no separate `NEXT_PUBLIC` flag to keep in sync.

Beyond the env vars, posting also requires **Meta App Review** for `pages_manage_posts` + `instagram_content_publish` (on top of the messaging review). Until approved, only Meta app admins/testers can connect. See [Social Planner](features/social-planner.md) + the Meta inbox section of [AI Agents](features/ai-agents.md).

## Optional — WhatsApp Cloud API
Each sub-account connects its own Meta WhatsApp Cloud sender (phone number id, WABA id, system-user token) under Settings → Messaging; nothing deployment-wide is required. The Settings → WhatsApp page (profile, quality badge, message links) and the hourly quality poll (`leadstack-whatsapp-quality` → `/api/cron/whatsapp-quality`) call the Graph API with that stored token.

| Var | Purpose |
|---|---|
| `FFMPEG_PATH` / `FFPROBE_PATH` | Optional. Absolute paths to ffmpeg and ffprobe (≥ 5, ffmpeg built with libx264 and aac); unset, both are looked up on `PATH`. When both are found and pass a version check (once per process), composer videos are converted server-side to fit the rail (`src/lib/comms/whatsapp/video-transcode.ts`): phone `.mov`/`.3gp`/`.mp4` up to 250 MB and 180 s. When either is missing — the norm on Vercel — videos keep the rail's own cap (16 MiB Cloud, 8 MiB bridge) and must already be H.264/AAC MP4. A set path that does not work turns conversion off; it never falls back to `PATH`. |
| `WHATSAPP_GRAPH_VERSION` | Optional. Graph API version for every WhatsApp Cloud call (sends, templates, settings, inbound media download). Default `v23.0`. Inbound photos, voice notes and documents are stored in `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`; without it the message still lands and the row records `mediaDropped: "fetch_failed"`. |

**Dev/CI only — never set on production** (the deploy guard refuses any mention of these names, exactly as for `GBP_PROVIDER`):

| Var | Purpose |
|---|---|
| `WHATSAPP_SETTINGS_PROVIDER` | `fake` swaps Meta for the deterministic fake settings provider (`src/lib/comms/whatsapp/settings/fake.ts`) behind the Settings → WhatsApp page and the quality poll. Unset/anything else = real Meta. Honoured only when `NEXT_PUBLIC_APP_URL`'s host is exactly `127.0.0.1`, `localhost` or `[::1]`; otherwise every WhatsApp settings route refuses loudly (`WaFakeRefusedError`) rather than falling back. Sends never go through this seam. |
| `WHATSAPP_FAKE_ALLOW_PROD_BUILD` | `1` lets the fake run in a `NODE_ENV=production` build — needed only because CI's Playwright job boots the production bundle on 127.0.0.1. Any other value refuses. |
| `WHATSAPP_FAKE_AGENCY_ID` | Required with `WHATSAPP_SETTINGS_PROVIDER=fake`: the fake serves only sub-accounts of this agency (set it to the E2E fixture agency). Local dev and CI use the production Firestore, so this is what stops a fake profile write or quality alert landing on a real tenant. |

## Optional — Google Calendar sync
Reuses the Google Business Profile OAuth client and its one redirect URI (below) — no new variable. Enable the **Google Calendar API** on the same Cloud project and add `https://www.googleapis.com/auth/calendar.events` (plus `openid` / `email`) to the consent screen. Each member then connects their own calendar under Settings → Calendar sync, once the agency turns on `googleCalendarEnabledByAgency`. See [google-calendar-sync.md](features/google-calendar-sync.md).

**Dev/CI only — never set on production** (the deploy guard refuses any mention of these names, exactly as for `GBP_PROVIDER`):

| Var | Purpose |
|---|---|
| `GCAL_PROVIDER` | `fake` swaps Google Calendar for the fake (`src/lib/google-calendar/provider/fake.ts`): each member's calendar is the Firestore doc `subAccounts/{id}/private/googleCalendarFake_{uid}`. Unset/anything else = real Google. Honoured only when `NEXT_PUBLIC_APP_URL`'s host is exactly `127.0.0.1`, `localhost` or `[::1]`; otherwise every Google Calendar path refuses loudly (`GcalFakeRefusedError`) — busy loading then fails open. |
| `GCAL_FAKE_ALLOW_PROD_BUILD` | `1` lets the fake run in a `NODE_ENV=production` build (CI's Playwright job boots the production bundle on 127.0.0.1). Any other value refuses. |
| `GCAL_FAKE_AGENCY_ID` | Required with `GCAL_PROVIDER=fake`: the fake serves only sub-accounts of this agency (the E2E fixture agency) — dev and CI use the production Firestore. |
| `REVIEWS_AI_PROVIDER` | **Dev/CI only.** `fake` swaps OpenRouter for the deterministic Reviews AI fake (`src/lib/reputation/ai/fake.ts` — sentiment by whole-word keyword rule; every call logged as ids + count, never text, at `subAccounts/{id}/private/reviewsAiFakeLog`). Unset/anything else = OpenRouter (`OPENROUTER_API_KEY`). Honoured only when `NEXT_PUBLIC_APP_URL`'s host is exactly `127.0.0.1`, `localhost` or `[::1]`; otherwise every Reviews AI path refuses loudly (`ReviewsAiFakeRefusedError`) and never falls back to OpenRouter. |
| `REVIEWS_AI_FAKE_ALLOW_PROD_BUILD` | **Dev/CI only.** `1` lets the fake run in a `NODE_ENV=production` build (CI's Playwright job). Any other value refuses. |
| `REVIEWS_AI_FAKE_AGENCY_ID` | **Dev/CI only.** Required with `REVIEWS_AI_PROVIDER=fake`: the fake serves only sub-accounts of this agency (the E2E fixture agency). |

## Dev/CI only — E2E booking rate-limit bypass

| Var | Purpose |
|---|---|
| `E2E_DISABLE_BOOKING_RATE_LIMITS` | `1` skips the public booking routes' per-IP / per-sub-account rate limits (`availability` + `book`, `src/lib/booking/rate-limit-e2e.ts`) — the whole Playwright suite runs from one loopback client, which would otherwise trip them mid-run. Honoured only when `NEXT_PUBLIC_APP_URL`'s host is loopback (the same wide fence `instrumentation.ts` uses); refused by name by the deploy guard exactly like `GBP_PROVIDER` / `GCAL_PROVIDER`. |

## Optional — Google Business Profile
One Google OAuth client lets each sub-account connect the Google account that manages its Business Profile listings. Optional — leave unset and the Connect button reports "not configured on this deployment".

| Var | Source |
|---|---|
| `GOOGLE_CLIENT_ID` | [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials → Create credentials → OAuth client ID → **Web application**. |
| `GOOGLE_CLIENT_SECRET` | Same screen. Keep secret. |

Grant the `https://www.googleapis.com/auth/business.manage` scope on the OAuth consent screen, and register **one** authorised redirect URI for the whole deployment: `NEXT_PUBLIC_APP_URL` + `/api/google/callback`. Google matches it byte for byte, so a trailing slash or a different host breaks the exchange. The connecting sub-account travels in the HMAC-signed OAuth `state` (keyed by `AUTOMATIONS_TOKEN_SECRET`), so no per-client registration is needed. Tokens are stored server-only at `subAccounts/{id}/private/googleConnection`; the sub-account doc carries display metadata only.

**Dev/CI only — never set on production:**

| Var | Purpose |
|---|---|
| `GBP_PROVIDER` | `fake` swaps Google for the deterministic fake provider ([gbp-reviews.md](features/gbp-reviews.md)). Unset/anything else = real Google. Honoured only when `NEXT_PUBLIC_APP_URL`'s host is exactly `127.0.0.1`, `localhost` or `[::1]` (not `0.0.0.0`, `127.0.0.2` or `*.localhost`); otherwise every Google route refuses loudly (`GbpFakeRefusedError`) rather than falling back. |
| `TRUST_CF_CONNECTING_IP` | `1` makes every per-IP rate limiter (and the pay-link consent IP) key on Cloudflare's `cf-connecting-ip` — one helper, `clientIpFrom` in `src/lib/checkout/rate-limit.ts`. Set it **only** where the app is reachable solely through a Cloudflare tunnel that sets that header (CrestaHQ's own velo deployment). Unset (the default, and required on Vercel) = the right-most `X-Forwarded-For` hop (the one the proxy appended), else `x-real-ip`, because a client could send its own `cf-connecting-ip` and its own left-most `X-Forwarded-For` entries. |
| `GBP_FAKE_ALLOW_PROD_BUILD` | `1` lets the fake run in a `NODE_ENV=production` build — needed only because CI's Playwright job boots the production bundle on 127.0.0.1. Any other value refuses. |
| `GBP_FAKE_AGENCY_ID` | Required with `GBP_PROVIDER=fake`: the fake serves only sub-accounts of this agency (set it to the E2E fixture agency). Local dev and CI use the production Firestore, so this is what stops a fake connection overwriting a real tenant's Google tokens. |
| `REVIEWS_AUTO_REPLY_ENABLED` | **Kill switch for review auto-reply** ([AUTO_REPLY_V1_PLAN.md](../AUTO_REPLY_V1_PLAN.md)). `1` = after each Google review sync (the cron and Sync now), the engine may draft replies for sub-accounts that switched auto-reply on and **post rating-only ones to Google without a click**. Unset/anything else = the engine never runs on this deployment — no review is read, drafted or posted, whatever any sub-account's settings say. Also re-read inside every post's final transaction. A change takes effect only after a restart/redeploy; to stop it, set it to `0` — see [RUNBOOK.md](../RUNBOOK.md#review-auto-reply). Its alerts use the existing rails: web push ([Push notifications](#optional--push-notifications-pwa)) and email (the shared sender, [email](#required-for-email-disables-cleanly-if-missing), or the sub-account's verified SMTP); a missing channel logs a warning and the other still delivers. The settings card shows whether it is set (as a boolean, never the value). CI's E2E job sets it to `1` (`gbp-auto-reply.spec.ts`): with the GBP or Reviews AI fake the engine serves only that fake's fixture agency, refusing any other sub-account (after reading its doc for the agencyId) before any write. |
| `GBP_SYNC_SCHEDULE_ENABLED` | `1` = register the 6-hourly Google Business Profile review sync (`leadstack-gbp-sync`, `0 */6 * * *` → `/api/cron/gbp-sync`) with the other QStash schedules at cold start, and let the Google Business page say "Syncs automatically every 6 hours". Unset/anything else = no schedule; the page says automatic sync is not scheduled, the sync cron answers `not_scheduled` and syncs nobody (a leftover QStash schedule is harmless), and only Sync now syncs. Retention does NOT depend on this flag: its daily job (`gbp-retention` in the `leadstack-daily-housekeeping` schedule, Firestore only, no Google calls) is always registered. Turning it on in production is an owner step ([gbp-reviews.md](features/gbp-reviews.md)). |

`scripts/deploy-velo.sh` runs `scripts/gbp-deploy-check.mjs` twice. **Before building** it refuses when any `.env*` file in the deploy dir contains the text `GBP_PROVIDER`, `GBP_FAKE_`, `WHATSAPP_SETTINGS_PROVIDER`, `WHATSAPP_FAKE_`, `SMS_PROVIDER`, `SMS_FAKE_`, `GCAL_PROVIDER`, `GCAL_FAKE_`, `REVIEWS_AI_PROVIDER`, `REVIEWS_AI_FAKE_` or `E2E_DISABLE_BOOKING_RATE_LIMITS` anywhere (comments included), when a deploy-shell variable is named so, when `NEXT_PUBLIC_APP_URL` is *defined* more than once in `.env.production`, or when it is defined in any other env file (`.env.example` exempt; comment lines never count as definitions). **After building** it extracts the URL literal inlined into each fake-provider check (GBP's, the WhatsApp settings fake's, the SMS fake's, the Google Calendar fake's and the Reviews AI fake's) in each server chunk and refuses unless every one equals the app URL `sed` read from `.env.production`, that URL parses and is not loopback, and all five checks were found. (`E2E_DISABLE_BOOKING_RATE_LIMITS` has no post-build check — it isn't inlined into the bundle, so the pre-build name refusal is what keeps it out.) Neither check reads systemd `Environment=` lines; those cannot change the inlined URL, which is what the app fence compares.

## Required for leads map (disables cleanly if missing)
| Var | Source |
|---|---|
| `NEXT_PUBLIC_MAPBOX_TOKEN` | [account.mapbox.com](https://account.mapbox.com) → Tokens → Create. Free tier covers 50k map loads/month; default public scopes are fine. Public token (starts with `pk.`). |

Without this, the dashboard **Leads map** card renders a "Mapbox not configured" message instead of the map. Form submissions still capture location data (it's stored on the contact regardless) — the data just isn't visualized until you add the token.

Location capture happens server-side in `/api/forms/[id]/submit`: ipapi.co (free tier, 1k/day, no key) gives city + lat/lng; phone country-code parsing (via `libphonenumber-js`) is the fallback for country-level pins. Both fail soft — contacts always save, location fields are just nullable. CSV-imported and manually-created contacts have null location and won't pin on the map (no backfill in v1).

## Optional — Push notifications (PWA)
| Var | Source |
|---|---|
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Generate the pair once: `npx web-push generate-vapid-keys`. Build-time inlined (redeploy after setting) — the browser subscribes with it. |
| `VAPID_PRIVATE_KEY` | The private half from the same command. Server-only; signs every push. |

Without these, the app is still installable (custom-branded deployments only — `LANDING_VARIANT === "custom"`); the `/me/settings` Notifications card just shows "not configured" and `lib/push/send.ts` no-ops. Once set: users enable per device under **/me/settings → Notifications**, pick which sub-accounts notify, and get pushes for new leads, inbound conversation messages, new bookings, and missed calls. **iPhone caveat:** iOS only delivers web push to an app installed to the home screen (Share → Add to Home Screen) — the settings card and the mobile install banner both explain this. Run `firebase deploy --only firestore:rules,firestore:indexes` after pulling this feature (new `users/{uid}/pushSubscriptions`, `users/{uid}/settings`, and `agencies/{id}/pwaIcons` rules).

**App icon (home-screen logo):** the Branding card's logo URL brands the *pages* (sidebar, landing); the home-screen icon is separate. The agency owner uploads a square image under **Agency → Settings → Mobile app icon** — the browser renders the four required variants on a canvas (`lib/pwa/render-icons-client.ts`: 192/512, a padded maskable for Android's circle crop, apple-touch), `POST /api/agency/app-icon` validates real-PNG + exact dimensions + byte caps and stores them as base64 at `agencies/{id}/pwaIcons/{variant}` (Firestore, deliberately NOT Firebase Storage — no new product or rules surface for buyers), and the public `/api/pwa/icon/[variant]` route serves them (302 → the static `/public` PNGs until an upload exists, so the manifest + apple-touch link can always point at the route). `agency.pwaIconsUpdatedAt` is the existence flag + manifest cache-buster. Platform note: already-installed devices keep their cached icon until reinstall. Manual fallback still works: replace the four PNGs in `/public`.

## Required for marketing tracking (all optional, all build-time inlined)
| Var | Source |
|---|---|
| `NEXT_PUBLIC_META_PIXEL_ID` | Meta Events Manager → Data Sources → your Pixel. Numeric ID. When set, the Pixel loads on every page (including hosted forms) and hosted-form submissions auto-fire a `Lead` event client-side. Leave blank to skip. |
| `NEXT_PUBLIC_GTM_ID` | Google Tag Manager → Container ID, format `GTM-XXXXXXX`. When set, GTM loads site-wide (script in body + `<noscript>` iframe). Use this as the escape hatch for any tag Pixel doesn't cover — LinkedIn Insight, TikTok Pixel, Hotjar, custom server-side gtag. |

UTM/fbclid/gclid/referrer/landing-page are captured automatically on every public form submission regardless of whether the Pixel is configured — they're stored on `contact.attribution` for downstream use (Conversions API in Sprint B, campaign reporting later). The hosted form is at `/f/[id]`; the agency only needs to encode UTMs in the iframe `src` if embedding via iframe.

## Required for live chat / support (optional)
| Var | Source |
|---|---|
| `NEXT_PUBLIC_CRISP_WEBSITE_ID` | [app.crisp.chat](https://app.crisp.chat) → Settings → Website Settings → Setup Instructions → Website ID (UUID). |

Without this, the Crisp widget doesn't load and every "chat with us" button (pricing checkout-error fallback, privacy-policy contact line) silently no-ops. There's no `mailto:` fallback by design — this codebase doesn't assume you've got a monitored inbox set up at the support email. Either configure Crisp (free tier is fine), pick a different chat widget (Intercom, Tawk.to — swap the script in [src/app/layout.tsx](../src/app/layout.tsx)), or replace the `openCrispChat()` calls in [src/lib/crisp.ts](../src/lib/crisp.ts) with a route that points at your real support channel (email, contact form, etc).

---

# Optional: in-app guided setup form

An **optional, additive** alternative to hand-entering environment variables.
The agency owner opens **Agency → Guided setup** (`/agency/setup`), types the
remaining API keys, and LeadStack writes them to Vercel (and, in local dev, to
`.env.local`) and triggers a redeploy. Manual setup stays the default and is
fully supported — this only shortcuts the API-key-heavy tail. Full design:
`docs/plans/setup-env-form.md` (git-ignored, internal).

**Same source of truth.** The form writes real env vars; the app still reads
`process.env`. No feature changes how it reads config.

**Two paths with gating matched to blast radius:**

- **Local `.env.local` write** (local dev only) — needs only *(agency owner +
  running locally)*, detected via `!process.env.VERCEL`. No Vercel creds and no
  toggle: a developer can clone, `pnpm dev`, sign in, and fill `.env.local`
  through the form standalone. It only writes their own file.
- **Vercel write + redeploy** (production blast radius) — needs all three gates:
  1. **Firebase working + agency owner exists** (owner-gated, reads/writes Firestore).
  2. **Vercel preflight vars present** — `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`,
     `VERCEL_DEPLOY_HOOK_URL` (+ `VERCEL_TEAM_ID` if team-owned). Set manually in
     Vercel, then **redeploy once** so the build can read them.
     `vercelConfigured()` un-grays the toggle.
  3. **The Firestore toggle** `appConfig/setup.formEnabled` — owner flips it on
     in-app (no env var, no redeploy). Off by default. Governs the Vercel path only.

**Key detection (three states).** The status board merges the Vercel env-list
API (key *names* only — values are never decrypted or returned) with
`process.env`: `○ Not set` (neither) · `⏳ Saved · redeploy` (in Vercel, not yet
in the running build) · `✓ Active` (live, then shape-validated). Live values are
validated with the same `doctor` shape checks.

**Write targets.** On the deployed app: Vercel production only. Running locally
(`pnpm dev`, detected via `!process.env.VERCEL`): the form offers checkboxes to
write `.env.local` and/or push to Vercel in one submit ("set once, sync both").

**Security model.** Every `/api/agency/setup/*` route is owner-only
(`requireAgencyOwner`). Gating past that matches the target: the Vercel write +
`/redeploy` additionally require `formEnabled` AND `vercelConfigured()` (a
removed token fails those closed even with the toggle on); a local `.env.local`
write additionally requires only `isLocalDev()`. The preflight `VERCEL_*` keys
are **not writable via the form** (no privilege-escalation loop). Values are
never logged (only key names) and never returned to the client. `VERCEL_TOKEN`
is powerful (read/write all env + deploy) — scope it tightly and rotate if the
form is ever exposed. Recommended: flip the toggle back off once setup is done.

**Key files.** Shared catalog `src/lib/setup/env-schema.mjs` (also feeds
`pnpm doctor` — one source of truth) + typed view `src/lib/setup/catalog.ts`;
Vercel client `src/lib/vercel/client.ts`; local writer `src/lib/setup/env-file.ts`;
gate `src/lib/setup/guard.ts`; routes under `src/app/api/agency/setup/`; UI
`src/app/(dashboard)/agency/setup/page.tsx` + `src/components/agency/setup-env-form.tsx`.

---

