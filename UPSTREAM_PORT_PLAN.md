# Upstream port plan — LeadStack 1.0.26 → 1.0.40

Locked scope for porting upstream `leadstack-agency` changes into this fork. Upstream ships squashed force-pushed snapshots (1.0.26 = 898bcd5, 1.0.31 = b8439a9e, 1.0.40 = 68798611), so every unit is a hand port against our diverged files — never `git merge upstream`.

## Goal: Bring over every applicable upstream feature and fix without regressing the ~370 PRs we built since forking.

### Problems that would bite a verbatim port

1. **Dialer reads the Twilio auth token from the wrong place.** Upstream reads `sub.twilioConfig.authToken` in `api/sub-accounts/[id]/dialer/route.ts` (~37, 73, 179) and in both dialer webhooks (`webhooks/twilio/dialer/{twiml,status}/[subAccountId]/route.ts`); `lib/comms/dialer.ts` only takes the token as a parameter. Ours moved that token to `subAccounts/{id}/private/twilioCredentials` (read via `readSubAccountSecret(…, "twilio")` in `src/lib/comms/twilio.ts:193`). Ported as-is, every TwiML and status callback fails signature checks and provisioning breaks.
2. **Setup-snapshot dialog's "Don't show again" would fail.** It writes `users/{uid}.setupSnapshotDismissed` through the client SDK, relying on upstream's open `allow update` on `users/{uid}`. Our rule only allows `displayName`, `photoURL` and `updatedAt` (`firestore.rules:747-749`). The write fails silently, so the dialog reopens every session. Store the flag in `users/{uid}/settings/setupSnapshot`, which users can already write; no rules deploy needed. **Never copy upstream's `firestore.rules`** — our version (759 changed lines) contains this hardening.
3. **Upstream's pipelines would overwrite ours at the same paths.** Three upstream-added paths already exist in our fork: `src/app/api/sub-accounts/[id]/pipelines/route.ts`, `src/app/api/sub-accounts/[id]/pipelines/[pipelineId]/route.ts` and `src/app/api/google/callback/route.ts`. Do not port `lib/pipelines/resolve.ts`, `lib/server/pipelines-service.ts`, `hooks/use-pipelines.ts` or `lib/google/calendar.ts`; we built our own versions.
4. **Upstream's email readiness checks only Resend's env.** Speed-to-Lead readiness and the Website v2 publish hand-off call a no-argument `emailIsConfigured()`. Ours, `emailIsConfigured(sub)` in `lib/comms/resend.ts:35`, already handles per-sub-account SMTP (`emailProvider === "smtp"` and a verified config) and falls back to the Resend env (`RESEND_API_KEY` + `EMAIL_FROM`). Resend is unset in prod, but buyer copies use Resend (SETUP.md Phase 4). So the port must **pass the sub-account doc** to `emailIsConfigured(sub)` and must not drop Resend. Called without the doc, both report "email not ready" on SMTP tenants and drop the email steps from the auto-created workflow. Their WhatsApp readiness only knows the Twilio rail, so it must also be adapted to our Cloud API and bridge senders.
5. **Two upstream changes should not come over, and one should:**
   - `.env.example` sets the VAPID keys to the literal `tba`, which makes push look configured with junk keys.
   - `.gitignore` adds `*_PLAN.md`. Tracked files stay tracked, but every NEW `*_PLAN.md` (our locked-scope convention at the repo root) would be silently ignored by `git add`.

   One upstream change should come over: it removes the tracked `.claude/settings.local.json` (tracked in 898bcd5 and in our fork, absent in 1.0.40; it holds the upstream author's absolute path). Done in N6.
6. **Upstream's assistant tools live in one big file.** Its `src/lib/ai-suite/capabilities.ts` grew by 2,908 lines; we split ours into `src/lib/ai-suite/capabilities/*.ts`. New tools must go into new files, never a copy of upstream's file.
7. **Circular import between Web Voice and Website v2.** `web-voice-service` imports `resolvedAppUrl()` from `website-handoff-service`, which imports `updateWebVoiceSettings` back. Move `resolvedAppUrl` into a neutral `src/lib/server/app-url.ts`. It also does a GET with `redirect: "follow"` at runtime (`resolveFinalUrl`, 3 s timeout), which is exposed to the known DNS stalls on velo. `resolveFinalUrl` exists to follow redirects (the apex→www CORS fix). `resolveLiveUrl` feeds it a gitpage-reported URL, which is not ours, so it must go through the SSRF guard (`ssrf-callers.test.ts` has hand-written cases only and does not scan for new callers, so the port must **add a `resolveLiveUrl` case pointing at a loopback server**). But `publicFetch` in `lib/webhooks/public-fetch.ts` never follows redirects (a raw `http.request`; a 3xx comes back as the response, with no `res.url`), so the port is a **manual redirect loop for `resolveLiveUrl`**: one `publicFetch` per hop, reading `Location`, resolving it against the current URL, capped at ~5 hops, so every hop is re-checked. Keep `resolveFinalUrl`'s guarantees (upstream `website-handoff-service.ts:133-148`): it never throws; ONE `AbortSignal.timeout(3000)` is shared across all hops; and on hitting the hop cap, a missing `Location`, `NonPublicUrlError` or any other error it returns the input URL. Pass a small `maxBytes` to `publicFetch`, which otherwise buffers up to 5 MB per GET (`public-fetch.ts:29`). `resolvedAppUrl` fetches our own `NEXT_PUBLIC_APP_URL` (operator-set, not tenant-controlled), so it may keep plain `fetch` with redirect follow.
8. **Real bugs in our own pipelines (new find).** These still use hard-coded `won`/`lost` or default-pipeline labels:
   - `src/lib/comms/ai/context.ts:81,87,100` — the AI agent treats a deal that is Won in a custom pipeline as still open.
   - `components/dashboard/leads-map.tsx:57,326`
   - `components/quotes/quote-builder.tsx:247,704`
   - `components/search/command-palette.tsx:201,243`
   - `app/(dashboard)/sa/[subAccountId]/dashboard/page.tsx:140,349`
   - `lib/ai-suite/capabilities/deals.ts:55,88,181`

   Upstream fixed the equivalents.

---

### Inventory (every upstream change, 1.0.31 and 1.0.40)

**SKIP — upstream's own sales or distribution machinery, or template stubs**

| Unit | Upstream files | Reason |
|---|---|---|
| LeadStack Cloud (hosted fleet) | `app/(dashboard)/agency/cloud`, `api/agency/cloud/*`, `api/cloud/*`, `api/cloud-instance/domain` (69), `app/cloud/*`, `components/cloud/*`, `lib/cloud/*`, `lib/cloud-instance/{heartbeat 47,vercel-proxy 127}`, `lib/vercel/client.ts` +19, `instrumentation.ts` +10, `cron/gitpage-heartbeat` +10, `cloud-domain-section` 128, managed-key rows in `setup/status` route and `setup-env-form`, `/cloud` in `analytics-scripts`, Cloud group in env-schema, `cloudInstances` + `cloudSubdomains` rules | Upstream's own hosted business; every file is a stub in buyer copies |
| Affiliate extensions | `affiliates/replies`, `affiliate/dashboard/swipe`, disputes rebuttal, `payouts/void`, `purchaser-replies/*`, `webhooks/resend/purchaser-replies`, `webhooks/stripe/commissions`, `components/affiliate/*`, `lib/affiliate/*`, `types/affiliate` +31, `resend.ts` `replyToFor`/`sentTo`, `purchaser*` rules | Upstream's sales channel |
| Founders checkout, PayPal, abandoned-cart recovery | `api/checkout/*`, `api/agency/checkout-*`, `paypal-config`, `webhooks/{paypal,stripe/abandoned}`, `app/checkout`, `components/{agency,landing}/checkout-*`, `paypal-*`, abandoner components, `lib/paypal/{client,dispute,fulfil}`, `lib/stripe/{checkout-details-*,checkout-funnel-stats,founders-session,fulfil-founders 436,paypal-config,recovery-*}`, `lib/landing/{claim-offer,exit-offer-once}`, `lib/stripe/webhooks.ts` (+73/−349), `async_payment_succeeded` in the Stripe route (guards founders fulfilment only), `appConfig/checkoutDetails` rule | Upstream's sales funnel |
| SEO and marketing | `feature-map` (1,378 lines), `go-high-level-pricing`, `gohighlevel-alternatives`, `compare/*`, `data/comparisons/*`, landing schema/FAQ/meta, `page.tsx` +10, `robots`, `sitemap`, `brand-cycle` CSS +38, about page, terms page + `terms-version`, `leadstack-vs-*`, LeadStack-variant OG tags in `layout.tsx` | Marketing for upstream's own site |
| Stubbed-out mothership code | gitpage-reminder (2 routes + 2 libs), `buyer-map-config`, `deal-config`, `exit-intent-config`, `updates-modal-config` routes, hooks and libs, `deal-editor` (+3/−707), world-countries geojson move | Upstream replaced these with `// Stub — see publish/README.md`. Our fork still has the full versions: they are dead-code candidates to mention, not delete |
| Repo hygiene | `.gitignore` `*_PLAN.md`, deleted plan docs, `VERSION`, `config/version`, README/RUNBOOK notes, VAPID `tba` | See problem 5 |
| Resend two-way email inbox | `webhooks/resend/inbound` 293, `lib/comms/email-inbox.ts` 272, `resend/inbox` route 125, `resend-domains` +45, `comms/email/send` +101, reply-to changes in `broadcasts/step` and `engine`, `sub-account-email-domain-section` (+733/−196, includes a DNS-provider stepper), `RESEND_WEBHOOK_SECRET` | **HAVE** a different rail: SMTP/IMAP via `lib/comms/{smtp,imap}.ts` and `lib/server/email-conversations.ts`, writing the same `contacts/{id}/emailMessages` collection that `conversation-thread.tsx:137` already reads |
| Setup skill | `.claude/skills/setup/*` (716 lines), `.claude/settings.json` | Defer. Buyer onboarding for Vercel; our SETUP.md has diverged (64 changed lines), and upstream itself warns it must be kept in sync in three places |
| "Beta" labels dropped | manage dialog, meta section, CLAUDE.md | Cosmetic; that's a product call for Hein. Our dialog has 724 changed lines |

**HAVE — we already built an equivalent**

| Unit | Our evidence |
|---|---|
| Multiple Pipelines | `src/lib/pipelines/{client,server,stages,write}.ts`; `capabilities/pipelines.ts` (list/get/create/update/delete); `pipeline_id` in `lib/api/serializers/deals.ts:34,165`; pipeline filter on workflow triggers (`engine.ts:1440`); `move_stage` uses `pipelineId` (`engine.ts:991`); `dealOutcome()` used by dashboard, reports and attribution. Gaps are unit N1 below |
| Google Calendar sync | `src/lib/google-calendar/*` plus the `googleCalendarEnabledByAgency` gate. Busy times feed availability, booking, reschedule and voice booking; bookings push to Google on book, reschedule, cancel, expiry, assign, delete and member removal. Wider coverage than upstream |
| runAfterResponse | PR 1 in progress (`CrestaHQ-wt-after-response`) |
| Upstream assistant tools we already have — **PARTIAL** | `update_contact`, `list_workflows`, `get_workflow`, `update_workflow`, `set_workflow_status`, `list_pipelines`, `create_pipeline`, `find_quotes` (our `list_quotes`), `mark_quote_paid`, `list_snapshots`, and `configure_workflow` (our `update_workflow` in `capabilities/workflow-edit.ts` replaces all steps; `{{unsubscribeLink}}` is appended at send time in `workflows/engine.ts:255-263`). **Caveat:** our versions are `surfaces: ["agent"]` (Agent API only) and the in-app chat route refuses them (`api/ai-suite/chat/route.ts:269`, `availableOn(cap, "chat")`); upstream had them in chat. **Ruling:** STL-1 widens `surfaces` to include `"chat"` for `list_workflows`, `get_workflow`, `update_workflow` and `set_workflow_status` (the P2 playbook needs them). `update_contact`, `list_pipelines`, `create_pipeline`, `list_quotes`, `mark_quote_paid` and `list_snapshots` are decided per tool in N2a. Chat writes stay admin-only and confirm-gated per the chat route's convention. Update the `surfaces` column of `capability-names.test.ts` on purpose. |

**PORT / PARTIAL — detailed in the next section:** P1 setup-snapshot dialog, P2 Speed-to-Lead, P3 Website v2, P4 Web Voice, P5 Softphone, N1–N6 (new required finds), N7, N8, N12 (in scope per Hein's rulings), N9–N11 and N13 (optional).

---

### PORT / PARTIAL units

Line counts are additions, tests excluded. "Churn" means `git diff 898bcd5 origin/main | wc -l` for that file.

**P1 — Owner setup-snapshot dialog (PORT with changes, ~380 lines)**
- **Files:**
  - `src/components/agency/setup-snapshot-dialog.tsx` (new, 329)
  - `api/agency/setup/summary/route.ts` +15, adds `groups[]` (churn 0)
  - `components/dashboard/app-shell.tsx` +2 (churn 82)
  - `src/lib/setup/env-schema.mjs` +9: new Google group using **our** env names `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, not upstream's `GOOGLE_OAUTH_*` (churn 85)
- **Changes needed:**
  - Store the dismissal in `users/{uid}/settings/setupSnapshot` (problem 2).
  - Rewrite `HEADLINE_TITLES` for our catalog: Paystack client billing, the WhatsApp bridge, a Google group. Relabel "Email (Resend)" to "Email" and judge it with `emailIsConfigured(sub)`-style logic (SMTP or Resend env) — a Resend-only check would show "Not set up" on our SMTP deployment.
- **Rules, env, gates:** none.
- **Verify:**
  - A vitest on the summary route that `groups` carries no key names or values.
  - A unit test of the show rule (owner only, session flag, dismissed flag), mutation-checked.
  - A live walk as agency owner on crm.crestahq.com.
- **Merge:** eligible to merge without Hein reading the diff (owner-only, no client data).

**N1 — Pipeline stage-resolution sweep (PARTIAL, a real bug, ~250 lines)**
- **Files:** `lib/comms/ai/context.ts` (churn 0), `leads-map.tsx` (21), `quote-builder.tsx` (21), `command-palette.tsx` (30), dashboard `page.tsx` (105), `capabilities/deals.ts`, plus three more sites:
  - `workspace_stats` in `capabilities/workspace-lookups.ts` (~198-205): stage counts iterate `PIPELINE_STAGES` and open value excludes only `won`/`lost`, so custom-pipeline stages vanish.
  - `create_deal` in `capabilities/deals.ts` (~127, 198): default pipeline only; upstream added a `pipeline` argument.
  - `STAGE_IDS` in `capabilities/helpers.ts` (~40): built from the default `PIPELINE_STAGES`.
- **Conditional:** `bulk-email-dialog.tsx` (45) and `bulk-call-dialog.tsx` (57) — only if our broadcast/voice audience resolver accepts custom-pipeline stage ids. Check first.
- **How:** rewrite against our `dealOutcome`/`usePipelines` (`hooks/use-pipeline-stages`). Never import upstream's `use-pipelines` or `resolve`.
- **Verify:** a test that a custom-pipeline Won deal is excluded from the context block's "Active deals"; leads-map sort; quote-builder open-deal filter. Mutate `dealOutcome` and watch them fail.
- **Merge:** Hein gate — it changes the AI context used in customer replies.

**N3 — Style presets for checkout and booking pages (PORT, ~650 lines)**
- **Checkout files (all churn 0):** `lib/checkout/themes.ts` 288, `components/checkout/theme-preset-picker.tsx` 97, `checkout-form.tsx` +76/−39, `co/[subAccountId]/[slug]/page.tsx` +13/−10, the checkout settings page +20, `types/checkout-pages` +22, `lib/checkout/sanitize` +11, `checkout-pages` route +2.
- **Booking files:** `types/booking` +10 (churn 126), `lib/booking/validation` +17 (319), `defaults` +1 (0), `duplicate` route +1 (47), the theme part of `booking-page-editor` (~15 of +68; churn 339), `public-booking-view` +57/−11 (360), including the dark-mode `[&_option]` fix.
- **Conflict risk:** medium on the booking files; our booking flow diverged heavily (calendar types, team modes).
- **Verify:** `validateThemePreset` and sanitize reject unknown presets; legacy pages resolve to the same look; a Playwright run on a public `/b` page with and without a preset.
- **Merge:** Hein gate (public pages). With the default `null` preset the pages are byte-identical to today.

**N4 — Web-chat contrast fix for light accent colours (PORT, ~110 lines)**
- **Files:** `components/web-chat/contrast.ts` (new, 57), `public/widget.js` +19 (churn 22), the non-voice parts of `chat-window.tsx` (churn 0).
- **Verify:** a unit test of `textOnAccent` (yellow gives dark text, navy gives white).
- **Order:** must land before WV-4, which touches the same files.

**N5 — Report charts: y-axis labels and hover tooltips (PORT, ~65 lines)**
- **Files:** `components/reports/charts.tsx` +46/−13 (churn 0); reports `page.tsx` `formatValue` +4 (churn 156).

**N6 — Small fixes, one PR with one commit each (~120 lines)**
1. `sr-only` causing a second scrollbar or a phantom label: calendar `page.tsx:100` (churn 107), `booking-reassign.tsx:121` (41), `setup-env-form.tsx:423,734` (13).
2. Resend domain status sync on read: `api/sub-accounts/[id]/resend/route.ts` +14 (churn 0) — for buyer copies that use Resend domains.
3. `metadataBase` and custom-variant OpenGraph in `app/layout.tsx` (churn 0). Derive the origin from `NEXT_PUBLIC_APP_URL` inline; don't import `landing-meta`.
4. `setup-env-form` "Already configured" collapse (+45).
5. Remove the tracked `.claude/settings.local.json` (`git rm`; see problem 5).
- **Verify:** a test that `metadataBase` falls back on a bad URL; a test that the status sync writes only on change.

**P2 — Speed-to-Lead Setup Assistant (PORT with heavy changes, 2 PRs)**
- **STL-1 (~350):**
  - `src/lib/server/forms-service.ts` (new, 135; we have no server-side forms service).
  - New capability files for `list_forms` (28), `create_form` (64) and `test_workflow` (49, wraps our `enrollForTest` at `engine.ts:2409`).
  - Optional `formId` on our `create_workflow`.
  - Registry and agency-delegated list entries in `capabilities.ts` (churn 4,152); `pnpm check:tenancy` must pass.
  - **Widen `surfaces` to include `"chat"`** for `list_workflows`, `get_workflow`, `update_workflow` and `set_workflow_status` (see HAVE row), and update `capability-names.test.ts`. Chat writes are admin-only and confirm-gated.
  - **Merge: Hein gate** (it changes what the in-app assistant may do).
- **STL-2 (~450):**
  - `speed_to_lead_readiness` (~250), **rewritten**: email readiness via `emailIsConfigured(sub)` (SMTP, else Resend env; problem 4), our WhatsApp sender/template checks, Twilio SMS with `sharedSmsAllowed`, QStash, push and usage.
  - `update_website_cta` (~90) plus `updateWebsiteCtaAndRebuild` in `websites-service.ts` (churn 30).
  - `check_website_status` reports CTA and site id.
  - `speedToLeadSection` in `lib/ai-suite/prompt.ts` (churn 0).
  - KB card `speed-to-lead-setup` (KB churn 34).
- **Do not port `configure_workflow`.** Point the playbook at our `get_workflow` + `update_workflow`, which STL-1 makes chat-callable.
- **Flags:** `test_workflow` sends real messages, and `update_website_cta` republishes a public site. Make both chat-only (not callable through the Agent API) and put a human gate on merge.
- **Verify:** readiness tests per channel (SMTP set or unset, **Resend env only** with no SMTP, gate off, no approved template); `create_form` blocks duplicate names; tenancy check passes; `list_workflows`/`update_workflow` callable from chat and still refused to non-admins.
- **Docs:** `docs/features/workflows.md` (new tools, chat surface); `docs/features/ai-agents.md` if the playbook changes agent behaviour.

**P3 — Website Build v2 (PORT, 7 PRs). Merges dark: prod has no `GITPAGE_API_KEY` and `websiteEnabledByAgency` stays off. Docs marked NOT runtime-verified.**

Shared-file churn is low throughout: `website-builder.tsx`, `types/website.ts`, `niches.ts`, `validation.ts`, the poll, poll-now and `[siteId]` routes, `refresh-kb` and the website page are all 0; `gitpage/client.ts` is 14; `websites-service.ts` is 30. The new `PAGESPEED_API_KEY` (optional) goes in `.env.example`, env-schema and `docs/environment.md`. No rules or index changes (all queries are equality-only).

| PR | Files | Lines |
|---|---|---|
| WS-1 types and pure libs | `types/website.ts` +633 (~340 types/helpers, ~290 niche samples), `lib/website/premium.ts` 288, `niches.ts` +45 (agency_consulting, ai_consulting, ai_automation), `validation.ts` +23 | ~990 |
| WS-2 client, settle, callback (new public unauthenticated webhook) | `gitpage/client.ts` +246, `websites-service.ts` +269 (without hand-off), `poll` +31/−30, `poll-now` +13/−20, `[siteId]` PATCH draft +58, `website/concepts` route 62, `webhooks/gitpage/build-settled` 89, `middleware.ts` +3 (churn 443, additive) | ~770 |
| WS-3 hand-off on publish | `website-handoff-service.ts` 481 **without the voice branch**; email check calls `emailIsConfigured(sub)` with the sub-account doc (SMTP or Resend env); new `src/lib/server/app-url.ts`; `refresh-kb` `{siteId}` +79 | ~600 |
| WS-4 after-publish tools | `[siteId]/domain` 144, `website-domain-dialog` 184, `pagespeed` route 50, `website-pagespeed.ts` 72, `website-seo-panel` 28, `website-edit-helper` 187, middleware pattern | ~670 |
| WS-5 form UI | `website-form-parts` 261, `website-premium-sections` 550 | ~810 |
| WS-6 wizard and card rewrite (needs G + WV-1: `website-wizard.tsx` reads `webVoiceEnabledByAgency` and `webVoiceMeta`, ~730-733) | `website-wizard` 876, `website-builder` +195/−1217, website `page.tsx` +36, getting-started copy | ~1,110 |
| WS-7 assistant | `list_website_concepts`, new `create_website` arguments, `check_website_status` stage and hand-off, KB | ~250 |

- **Verify:**
  - HMAC check on the build-settled callback (mutation test).
  - Settling is idempotent when the poll and the callback race.
  - `pollAttemptCapFor` / `pollDelayFor`.
  - The PATCH is refused while a build is in flight.
  - Hand-off steps run independently and record their errors.
  - The workflow is published only when a customer-facing step survives and QStash is set.
  - WS-3: email readiness cases for SMTP tenant, Resend-env-only tenant, and neither.
  - WS-2: a Playwright spec through the real server that POSTs a signed and an unsigned build-settled callback and loads the website page after the poll rewrite.
- **Docs:** `docs/environment.md` (`PAGESPEED_API_KEY`), `docs/architecture/firestore-collections.md` for any new private docs, `docs/features/website-builder.md` (v2 flow, marked NOT runtime-verified).
- **Merge:** Hein gate for WS-2 (public unauthenticated webhook plus a live poll rewrite), WS-3 (auto-publishes a speed-to-lead workflow that messages leads), WS-4 (web-chat origin allowlist and KB URL change) and WS-6 (non-additive rewrite of a public-site builder).

**P4 — Web Voice (ElevenLabs) (PORT, 4 PRs plus one gate PR). Merges dark behind `webVoiceEnabledByAgency`; docs marked NOT runtime-verified.**
- **G (shared with P5), ~180 lines:**
  - Two gates: `webVoiceEnabledByAgency` and **`dialerEnabledByAgency` (new; upstream has no dialer gate)**.
  - Wiring per docs/architecture/feature-gates.md:
    - `types/tenancy.ts` (churn 522)
    - `api/auth/signup` (177) and `sub-accounts-service` (335)
    - `feature-gates` route (253) and `feature-gates-service` `AgencyGateField` (116)
    - `sub-account-manage-dialog` (724)
    - `lib/audit/record.ts` `GATE_FIELDS` (a `Record<AgencyGateField, true>`, so tsc fails until both gates are listed)
    - `FEATURE_GATES` in `capabilities/helpers.ts` with `assistantMayEnable: false`
    - a row in the gates doc
  - Neither gate goes in `PLAN_GATE_KEYS`.
  - Note: the manage dialog has a known bug where a second Save silently reverts the first. Verify one gate at a time, in Firestore.
- **WV-1, connection backend (~890):** `types/web-voice.ts` 130, `lib/web-voice/elevenlabs.ts` 225, `web-voice-service.ts` 357 (imports `app-url.ts`), `api/sub-accounts/[id]/web-voice` 178.
- **WV-2, call path (~980; a new public webhook, `/api/webhooks/elevenlabs`):**
  - New files: `lib/web-voice/{tokens 98, rate-limit 34, speech 73}`, `web-voice-usage` 295, `web-chat/voice/start` 170, `web-chat/voice/event` 109, `webhooks/elevenlabs/llm/...` 135.
  - Edits: `web-chat/config` +23 (churn 21), voice mode in `web-chat/respond` +35 (80; **after P0**, which edits the same file), `session` +3 (44), middleware `/api/webhooks/elevenlabs`.
- **WV-3, settings card (~550):** `web-voice-section.tsx` 544, web-chat page +3.
- **WV-4, widget (~370):**
  - `chat-window` +~320 and `widget.js` (`vt` param, microphone permission) — **after N4**.
  - `web-chat/poll` +5, `web-chat-session-thread` +12 (churn 0), `conversation-thread` voice marker (churn 485).
  - Adds `@elevenlabs/client` to package.json.
- **WV-5 (~60):** `include_voice` and the hand-off voice branch, after WS-3 and WS-6 (WS-6 itself comes after WV-1).
- **Rules, env:** no rules change (secrets go under the existing deny-all `private/*`). Needs a public https `NEXT_PUBLIC_APP_URL`.
- **Docs:** `docs/environment.md` for any new env var; `docs/architecture/firestore-collections.md` for the new private doc and usage collection; new `docs/features/web-voice.md`, marked NOT runtime-verified.
- **Verify:** WV-2 needs a Playwright spec through the real server (gate off gives 403 and `voiceEnabled:false` on `web-chat/config`; the elevenlabs webhook rejects a bad path secret); WV-3 needs a page load of the settings card. Token HMAC and the path secret (mutation tests); cap and concurrency reservation inside a transaction; each call is settled once; voice mode drops `[[form]]`; gate off gives 403 and `voiceEnabled:false`. Live-check the negative path: the mic stays hidden while the gate is off.

**P5 — Softphone / browser dialer (PORT with a required change, 2 PRs after G). Merges dark behind `dialerEnabledByAgency`.**
- **SP-2, server (~680):**
  - `lib/comms/dialer.ts` 115, `api/sub-accounts/[id]/dialer` 199, `api/comms/dialer/token` 65, `webhooks/twilio/dialer/{twiml 132, status 110}`.
  - Types: `DialerConfig` and `DialerPrivateDoc` in `types/tenancy`; `call_placed` activity in `types/contacts` (churn 156).
  - **All auth-token reads go through `readSubAccountSecret`** (problem 1).
  - Gate check in the token, TwiML and provisioning routes.
  - Webhooks sit under the existing public `/api/webhooks/twilio` prefix, so no middleware change.
- **SP-3, UI (~470):** `browser-call-bar` 259, `sub-account-dialer-section` 160, `contact-profile-header` +35 (churn 109), `activity-timeline` +5 (367), settings page +3 (178), `@twilio/voice-sdk`.
- **Rules, env:** none. **Docs:** `docs/architecture/firestore-collections.md` (`DialerPrivateDoc` private doc), `docs/environment.md` if any env var is added, new `docs/features/dialer.md`, marked NOT runtime-verified.
- **Flag:** provisioning creates an API key and a TwiML App on the client's own Twilio account, which is an external action. Disabling should clean them up; confirm the behaviour.
- **Verify:** signature check against the private-doc token (mutation test); `voiceOptedOut` is blocked on the server; the dial target is resolved from the contact document, never from the client; recording defaults off; gate off gives 403. SP-2 and SP-3 each need a Playwright spec through the real server: SP-2 posts to both Twilio dialer webhooks with a good and a bad signature and requests the token with the gate off; SP-3 loads the settings page and the contact profile (Call button hidden with the gate off).

**N2 — Assistant tool batch from upstream's 2026-09-08 release (PARTIAL: the services exist in ours, only the tool layer is missing)**
- **Every N2 tool must state its surface and approval class** in its definition and in the `capability-names.test.ts` row; none ships with the default.
- **N2a, workspace tools (~580; Hein gate):** `pause_all_workflows` (56), `find_awaiting_payment_bookings` + `mark_booking_paid` (103), `list_communities` + `add_course` + `add_lesson` (250), `watchdog_status` + `configure_watchdog` (171; `upsertWatchdogConfig` exists at `agents-watchdog-service.ts:83`).
  - `pause_all_workflows`: `pause=false` resumes every automation, so **chat-only**, admin, confirm-gated.
  - `mark_booking_paid` **sends the customer's booking confirmation email** (`markBookingPaid` in `bookings-service.ts` rotates the token and confirms). It needs a decision before build: chat-only (human-confirmed), or an approval class so `outbound-never-sends.test.ts` passes on the agent surface. Do not leave it a direct write on `agent`.
  - **Every N2 tool placed on the agent surface needs a row in `src/test/outbound-fixtures.ts`** (`FIXTURE_ARGS` for sub-account tools, `AGENCY_FIXTURE_ARGS` for agent-callable agency tools in N2b), or `outbound-never-sends.test.ts` fails its coverage assertion (`:176`, `:226`). That applies to the read tools and to any N2a decision that widens `update_contact`, `list_pipelines`, etc. onto a new surface, not only `mark_booking_paid`.
  - Read tools (`find_awaiting_payment_bookings`, `list_communities`, `watchdog_status`) take `chat` + `agent`; writes `add_course`, `add_lesson`, `configure_watchdog` are chat-only, admin, confirm-gated unless N2a records a reason to widen. Also decide here the surfaces for `update_contact`, `list_pipelines`, `create_pipeline`, `list_quotes`, `mark_quote_paid` and `list_snapshots`.
- **N2b, agency tools (~410; Hein gate):** `billing_overview`, `comp_client`, `resend_checkout_link`, `sub_account_usage`, `set_usage_limits`, `deployment_setup_status`. `compSubAccount`, `mintCheckoutLink`, `effectiveBillingState`, `getEffectiveQuotas` and `computeOverage` already exist in ours, adapted to Paystack. `deployment_setup_status` needs an `EXTERNAL_ONLY` exemption in `scripts/check-capability-tenancy.mjs` (churn 198).
- **Flag:** `comp_client` cancels a subscription, which is irreversible. Make it chat-only.

**In scope per Hein's rulings (7 and 8 are Hein gates; 12 merges last in Lane A)**
- **N7 Email AI drafts (~350; Hein gate: customer-facing AI replies; own lane, after P0 and G).** Upstream's draft-only `"email"` channel: `agent.ts` (churn 125), `gates.ts` (18), `prompt.ts` (12), `respond.ts` (304), channels route (153), new `email-channel-section` 197, email AI page (0). It needs a new hook in our IMAP inbound path; today `email-conversations.ts` never calls `maybeRespondWithAi`. Upstream gates it on the Resend email-domain gate, so it gets its **own new agency gate** (default off, wired per feature-gates.md including `GATE_FIELDS`). Optionally add the quoted-reply collapse (`lib/email-quote.ts` 87). Do N11 with it.
  - **Verify:** drafts are never auto-sent (outbound seams stay at 0); gate off gives no draft; inbound SMTP/IMAP path hook tested; a Playwright spec through the real server on the email AI settings page.
  - **Docs:** `docs/environment.md` for any new env var; `docs/architecture/firestore-collections.md` for new private docs; new `docs/features/email-ai.md` (or a section in `ai-agents.md`).
- **N8 Recreate GHL pipelines on import (~180; Hein gate: writes imported client data).** `ghl/start` (22), `transform` (49), `bulk-write` (243), wizard (34). Test against fixtures only, never a live sub-account.
- **N12 KB card refresh (15 new upstream cards, ~180 lines; last in Lane A, after WS-7 and WV-5).** Upstream added 19 cards between 1.0.26 and 1.0.40 (our `knowledge-base.ts` has 45 cards, none of these). Excluded: `speed-to-lead-setup` (STL-2 writes it), `fix-bugs-with-claude-code` (N13), `email-sending-domain` (the Resend-domain feature; adapt for SMTP/Resend or skip) and `deployment-and-support` (upstream's own support model). The 15 to port, each adapted to Paystack, WhatsApp Cloud/bridge and SMTP and written for what shipped: `calendar-sync` (describe our Google Calendar sync, not upstream's), `checkout-pages`, `meta-connection`, `voice-agent`, `outbound-voice`, `phone-dialer` (P5), `webinars`, `sms-whatsapp-setup`, `web-chat`, `web-voice` (P4), `funnels-labs`, `phone-region`, `your-account`, `which-key-powers-what`, `data-ownership-backups`. `phone-dialer` and `web-voice` only land if their gate has shipped, and say they are agency-enabled. Upstream's edits to 32 existing cards belong to the feature PRs that change those features, not here.

**Optional (each needs a decision before it's built)**
- **N9 `GET /api/v1/pipelines` (34).** The Agent API already offers `list_pipelines`.
- **N10 Booking-editor "calendar connected" host chips (~55).** Needs a status our members can read; our Google Calendar connection data sits under `gcalConnectionPath`.
- **N11 Email-channel loose ends (do with N7).** Add `email` to the push `CHANNEL_LABELS` (`push/events.ts:34`) and to the watchdog's `CHANNEL_COLLECTION` (`agents-watchdog-service.ts:155`). Check first whether inbound email emits `message.received`.
- **N13 Owner prompt section on fixing bugs with Claude Code (14 lines).**

---

### PR order, dependencies and parallel lanes

```
P0 runAfterResponse (in flight) ──► everything rebases after it merges
Lane E (independent, parallel after P0): N1 · N4 · N5 · N6 · N3 · P1 · N8
Lane F (own lane, after P0 and G): N7
Lane A (one at a time, all edit the capabilities registry + KB):
        STL-1 ─► STL-2 ─► N2a ─► N2b ─► WS-7 ─► WV-5 (create_website arg) ─► N12
Lane B (website): WS-1 ─► WS-2 ─┬─► WS-3 (also needs STL-1, for forms-service)
                                ├─► WS-4
                  WS-1 ─► WS-5 ─┴─► WS-6 (needs WS-2, G and WV-1) ─► WS-7
Lane C (dialer):  G ─► SP-2 ─► SP-3
Lane D (voice):   G + WS-3 (app-url) ─► WV-1 ─► WV-2 ─► WV-3 ─► WV-4 (needs N4)
                                  ├─► WV-1 also gates WS-6 in lane B
                                  └─► WV-5 (needs WV-1, WS-3, WS-6; not WV-4)
```

**Changes to the order you proposed (P0 → snapshot → STL → Website v2 → Web Voice → dialer):**
- N1 goes right after P0, in parallel with P1. It's a live correctness bug.
- The dialer doesn't need to wait until the end. Its files don't overlap with the website or voice work; it shares only the gate files, so the two gates go into one PR (G) to avoid six-file conflicts.
- WS-6 now waits for G and WV-1 (its wizard reads `webVoiceEnabledByAgency` and `webVoiceMeta`), so lane B's last UI PR trails the first voice PR.
- N7 is its own lane after P0 **and G**: its new gate touches the same files as G; it has its own merge gate; N12 is the last Lane A PR.
- STL must come before WS-3, because the hand-off needs `forms-service`. Web Voice must come after WS-3 (the `app-url` module and the hand-off voice branch). Both of these match your order.

**Expect small rebases where parallel PRs touch the same file:**
- `middleware.ts`: WS-2, WS-4, WV-2
- `types/tenancy.ts`: G, N7 (new gate), SP-2, WV-1
- Gate-wiring files (`feature-gates` route and service, manage dialog, `FEATURE_GATES` in `helpers.ts`, `audit/record.ts` `GATE_FIELDS`, `api/auth/signup`, `sub-accounts-service`): G, N7
- `env-schema.mjs`: P1, WS-4
- `capability-names.test.ts`: STL-1, N2a, N2b, WS-7 (every surface change edits the table)
- `package.json` / lockfile: SP-3, WV-4 — merge these one at a time
- `websites-service.ts`: STL-2, WS-2, WS-3
- `knowledge-base.ts`: lane A and the feature PRs

**Size and merge gate per PR.** "Hein gate" means Hein reads the diff before merge. "Eligible" means the CLAUDE.md conditions for merging without Hein reading the diff can be met: greenfield or additive, not customer-facing, no client data, objectively tested, and all gates green including a blind `/review` AND a security review (the global Level-3 gate requires both).

| PR | Lines | Merge |
|---|---|---|
| P1 | 380 | eligible |
| N1 | 250 | Hein gate |
| N3 | 650 | Hein gate |
| N4 | 110 | Hein gate |
| N5 | 65 | eligible |
| N6 | 120 | Hein gate (public OG/brand metadata) |
| G | 180 | eligible |
| STL-1 | 350 | Hein gate (widens in-app assistant surfaces) |
| STL-2 | 450 | Hein gate |
| N2a | 580 | Hein gate (`mark_booking_paid` emails the customer; `pause_all_workflows(false)` resumes everything) |
| N2b | 410 | Hein gate |
| WS-1 | 990 | eligible |
| WS-2 | 770 | Hein gate (public unauthenticated webhook, live poll rewrite) |
| WS-3 | 600 | Hein gate |
| WS-4 | 670 | Hein gate (web-chat origin allowlist, KB URL change) |
| WS-5 | 810 | eligible |
| WS-6 | 1,110 | Hein gate (non-additive rewrite of a public-site builder) |
| WS-7 | 250 | eligible |
| WV-1 | 890 | Hein gate |
| WV-2 | 980 | Hein gate |
| WV-3 | 550 | eligible |
| WV-4 | 370 | Hein gate |
| WV-5 | 60 | Hein gate |
| SP-2 | 680 | Hein gate |
| SP-3 | 470 | Hein gate |
| N7 | 350 | Hein gate (customer-facing AI replies) |
| N8 | 180 | Hein gate (writes imported client data) |
| N12 | 180 | eligible |

That is about 13,500 added lines over 28 PRs (25 core plus N7, N8 and N12; N1 grew to ~250). Production deploys stay after-hours with Hein's explicit go.

---

### Decisions for Hein
All settled; see **Hein's rulings** at the bottom. Open per-unit decisions are recorded in the unit (N2a surfaces and `mark_booking_paid`).

### feature_list.json
```json
{"project":"crestahq-upstream-port-1.0.40","planned_at":"2026-10-10","tech_stack":["Next.js 15","TypeScript","Firestore","QStash","Twilio","ElevenLabs","gitpage"],"last_session":null,"features":[
{"id":"p0-run-after-response","priority":0,"complexity":"medium","success_criteria":["in flight elsewhere"],"passes":false},
{"id":"n1-pipeline-terminal-sweep","priority":1,"complexity":"low","success_criteria":["AI context excludes custom-pipeline Won deals from Active","workspace_stats, create_deal pipeline arg and STAGE_IDS are pipeline-aware","leads-map/quote-builder/palette/dashboard use per-pipeline terminals","tests fail when dealOutcome is mutated"],"passes":false},
{"id":"p1-setup-snapshot-dialog","priority":1,"complexity":"low","success_criteria":["summary.groups has no key names","dismissal stored in users/{uid}/settings, no rules change","owner-only show rule tested","live walk on prod"],"passes":false},
{"id":"n4-webchat-contrast","priority":1,"complexity":"low","success_criteria":["textOnAccent unit-tested","widget bubble readable on yellow accent"],"passes":false},
{"id":"n5-chart-axes","priority":1,"complexity":"low","success_criteria":["y-axis labels and tooltips render; currency formatting on Won chart"],"passes":false},
{"id":"n6-small-fixes","priority":1,"complexity":"low","success_criteria":["no sr-only phantom scrollbar","tracked .claude/settings.local.json removed","Hein gate","resend status syncs on GET","metadataBase falls back safely","done groups collapse"],"passes":false},
{"id":"n3-style-presets","priority":1,"complexity":"medium","success_criteria":["unknown preset rejected","null preset byte-identical","Playwright on /b and /co"],"passes":false},
{"id":"g-gates-webvoice-dialer","priority":1,"complexity":"low","success_criteria":["both gates default false at both creation sites","PATCH, dialog and FEATURE_GATES wired","assistantMayEnable false"],"passes":false},
{"id":"stl-1-forms-workflow","priority":1,"complexity":"medium","success_criteria":["forms-service mirrors UI presets","list_forms/create_form/test_workflow pass check:tenancy","test_workflow chat-only","list/get/update_workflow and set_workflow_status callable from chat, admin-only, confirm-gated","capability-names.test.ts surfaces updated","Hein gate"],"passes":false},
{"id":"stl-2-readiness-cta","priority":2,"complexity":"medium","success_criteria":["readiness uses emailIsConfigured(sub) (SMTP or Resend env, incl. a Resend-only test case) and our WA rails","update_website_cta chat-only","prompt section renders only with actions"],"passes":false},
{"id":"n2a-workspace-capabilities","priority":3,"complexity":"medium","success_criteria":["9 tools anchored on ctx.subAccountId","confirm-gated writes","every tool states surface and approval class","pause_all_workflows chat-only","mark_booking_paid decided (chat-only or approval class) and outbound-never-sends passes","Hein gate"],"passes":false},
{"id":"n2b-agency-capabilities","priority":4,"complexity":"medium","success_criteria":["Paystack-correct billing_overview","comp_client chat-only","deployment_setup_status exempted in tenancy script"],"passes":false},
{"id":"ws-1-types-libs","priority":1,"complexity":"medium","success_criteria":["premium parse/validate tests","addressOptional niches"],"passes":false},
{"id":"ws-2-client-settle-callback","priority":2,"complexity":"high","success_criteria":["HMAC mutation test","idempotent settle on race","poll cap/backoff"],"passes":false},
{"id":"ws-3-handoff","priority":3,"complexity":"high","success_criteria":["emailIsConfigured(sub) given the sub-account doc; Resend-only tenant still passes","steps independent and idempotent","workflow published only when sendable and QStash set"],"passes":false},
{"id":"ws-4-domain-pagespeed-edit","priority":3,"complexity":"medium","success_criteria":["www/apex allowlist","pagespeed QStash-signed"],"passes":false},
{"id":"ws-5-form-ui","priority":2,"complexity":"medium","success_criteria":["premium sections render; validation keys map to steps"],"passes":false},
{"id":"ws-6-wizard-card","priority":5,"complexity":"high","success_criteria":["depends on G and WV-1","draft saved per step","no Rebuild on live sites","docs NOT runtime-verified"],"passes":false},
{"id":"ws-7-assistant","priority":6,"complexity":"low","success_criteria":["list_website_concepts; create_website premium args"],"passes":false},
{"id":"wv-1-connection","priority":4,"complexity":"high","success_criteria":["key probed before store","secret only in private/","app-url extracted"],"passes":false},
{"id":"wv-2-call-path","priority":5,"complexity":"high","success_criteria":["token and path-secret mutation tests","cap reservation transactional","gate off gives 403"],"passes":false},
{"id":"wv-3-card","priority":6,"complexity":"medium","success_criteria":["locked state when gate off"],"passes":false},
{"id":"wv-4-widget","priority":7,"complexity":"medium","success_criteria":["mic hidden when voiceEnabled false (live-checkable)","SDK lazy-loaded"],"passes":false},
{"id":"wv-5-website-voice","priority":7,"complexity":"low","success_criteria":["hand-off never turns voice off"],"passes":false},
{"id":"sp-2-dialer-server","priority":2,"complexity":"high","success_criteria":["authToken via readSubAccountSecret","signature mutation test","voiceOptedOut blocked server-side","gate enforced"],"passes":false},
{"id":"n7-email-ai-drafts","priority":2,"complexity":"high","success_criteria":["draft-only, never auto-sent","own agency gate default off","IMAP inbound hook tested","Playwright through the real server","docs updated","Hein gate"],"passes":false},
{"id":"n8-ghl-pipeline-import","priority":1,"complexity":"medium","success_criteria":["pipelines recreated on import from fixtures","no live sub-account writes in tests","Hein gate"],"passes":false},
{"id":"n12-kb-refresh","priority":8,"complexity":"low","success_criteria":["15 cards adapted for Paystack, WhatsApp Cloud/bridge and SMTP","last in Lane A, after WS-7 and WV-5"],"passes":false},
{"id":"sp-3-dialer-ui","priority":3,"complexity":"medium","success_criteria":["Call button only when dialerConfig.enabled and gate on","call_placed timeline row"],"passes":false}]}
```
---

### Hein's rulings (2026-10-10)
1. Files over 300 lines: **port verbatim** — keep upstream's file shapes (no splitting), for both server and UI.
2. Dialer: **gated** — `dialerEnabledByAgency`, default off (unit G).
3. Optional extras: **N7 Email AI drafts, N8 GHL pipeline import, N12 KB card refresh are IN scope.** N9/N10/N11/N13 remain optional.
4. Merge-dark rule: Web Voice, Website v2 and dialer merge behind their gate, default off, docs marked NOT runtime-verified; first client to enable triggers a live walk.
