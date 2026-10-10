# Upstream port plan — LeadStack 1.0.26 → 1.0.40

Locked scope for porting upstream `leadstack-agency` changes into this fork. Upstream ships squashed force-pushed snapshots (1.0.26 = 898bcd5, 1.0.31 = b8439a9e, 1.0.40 = 68798611), so every unit is a hand port against our diverged files — never `git merge upstream`.

## Goal: Bring over every applicable upstream feature and fix without regressing the ~370 PRs we built since forking.

### Problems that would bite a verbatim port

1. **Dialer reads the Twilio auth token from the wrong place.** Upstream's `lib/comms/dialer.ts` and both dialer webhooks read `sub.twilioConfig.authToken`. Ours moved that token to `subAccounts/{id}/private/twilioCredentials` (read via `readSubAccountSecret(…, "twilio")` in `src/lib/comms/twilio.ts:193`). Ported as-is, every TwiML and status callback fails signature checks and provisioning breaks.
2. **Setup-snapshot dialog's "Don't show again" would fail.** It writes `users/{uid}.setupSnapshotDismissed` through the client SDK, relying on upstream's open `allow update` on `users/{uid}`. Our rule only allows `displayName`, `photoURL` and `updatedAt` (`firestore.rules:747-749`). The write fails silently, so the dialog reopens every session. Store the flag in `users/{uid}/settings/setupSnapshot`, which users can already write; no rules deploy needed. **Never copy upstream's `firestore.rules`** — our version (759 changed lines) contains this hardening.
3. **Upstream's pipelines would overwrite ours at the same paths.** `upstream-added-we-also-have.txt` lists `src/app/api/sub-accounts/[id]/pipelines/route.ts`, `…/[pipelineId]/route.ts` and `src/app/api/google/callback/route.ts`. Do not port `lib/pipelines/resolve.ts`, `lib/server/pipelines-service.ts`, `hooks/use-pipelines.ts` or `lib/google/calendar.ts`; we built our own versions.
4. **Upstream assumes email goes through Resend.** Speed-to-Lead readiness and the Website v2 publish hand-off check Resend's `emailIsConfigured()`. Our email is per-sub-account SMTP and Resend is unset in prod. Ported as-is, both report "email not ready" and drop the email steps from the auto-created workflow. Their WhatsApp readiness only knows the Twilio rail, so it must also be adapted to our Cloud API and bridge senders.
5. **Two upstream changes should not come over:**
   - `.env.example` sets the VAPID keys to the literal `tba`, which makes push look configured with junk keys.
   - `.gitignore` adds `*_PLAN.md`, which would untrack our locked-scope plan files at the repo root.
6. **Upstream's assistant tools live in one big file.** Its `src/lib/ai-suite/capabilities.ts` grew by 2,908 lines; we split ours into `src/lib/ai-suite/capabilities/*.ts`. New tools must go into new files, never a copy of upstream's file.
7. **Circular import between Web Voice and Website v2.** `web-voice-service` imports `resolvedAppUrl()` from `website-handoff-service`, which imports `updateWebVoiceSettings` back. Move `resolvedAppUrl` into a neutral `src/lib/server/app-url.ts`. It also makes a HEAD request at runtime, which is exposed to the known DNS stalls on velo.
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
| Upstream assistant tools we already have | `update_contact`, `list_workflows`, `set_workflow_status`, `list_pipelines`, `create_pipeline`, `find_quotes` (our `list_quotes`), `mark_quote_paid`, `list_snapshots`, and `configure_workflow` (our `update_workflow` in `capabilities/workflow-edit.ts` replaces all steps; `{{unsubscribeLink}}` is enforced in `workflows-service.ts`) |

**PORT / PARTIAL — detailed in the next section:** P1 setup-snapshot dialog, P2 Speed-to-Lead, P3 Website v2, P4 Web Voice, P5 Softphone, N1–N6 (new required finds), N7–N13 (optional).

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
  - Rewrite `HEADLINE_TITLES` for our catalog: Paystack client billing, the WhatsApp bridge, a Google group. Drop or relabel "Email (Resend)" — we send via SMTP, so it would show "Not set up" on our deployment.
- **Rules, env, gates:** none.
- **Verify:**
  - A vitest on the summary route that `groups` carries no key names or values.
  - A unit test of the show rule (owner only, session flag, dismissed flag), mutation-checked.
  - A live walk as agency owner on crm.crestahq.com.
- **Merge:** eligible to merge without Hein reading the diff (owner-only, no client data).

**N1 — Pipeline stage-resolution sweep (PARTIAL, a real bug, ~200 lines)**
- **Files:** `lib/comms/ai/context.ts` (churn 0), `leads-map.tsx` (21), `quote-builder.tsx` (21), `command-palette.tsx` (30), dashboard `page.tsx` (105), `capabilities/deals.ts`.
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
- **Verify:** a test that `metadataBase` falls back on a bad URL; a test that the status sync writes only on change.

**P2 — Speed-to-Lead Setup Assistant (PORT with heavy changes, 2 PRs)**
- **STL-1 (~350):**
  - `src/lib/server/forms-service.ts` (new, 135; we have no server-side forms service).
  - New capability files for `list_forms` (28), `create_form` (64) and `test_workflow` (49, wraps our `enrollForTest` at `engine.ts:2409`).
  - Optional `formId` on our `create_workflow`.
  - Registry and agency-delegated list entries in `capabilities.ts` (churn 4,152); `pnpm check:tenancy` must pass.
- **STL-2 (~450):**
  - `speed_to_lead_readiness` (~250), **rewritten** for SMTP email readiness, our WhatsApp sender/template checks, Twilio SMS with `sharedSmsAllowed`, QStash, push and usage.
  - `update_website_cta` (~90) plus `updateWebsiteCtaAndRebuild` in `websites-service.ts` (churn 30).
  - `check_website_status` reports CTA and site id.
  - `speedToLeadSection` in `lib/ai-suite/prompt.ts` (churn 0).
  - KB card `speed-to-lead-setup` (KB churn 34).
- **Do not port `configure_workflow`.** Point the playbook at our `get_workflow` + `update_workflow`.
- **Flags:** `test_workflow` sends real messages, and `update_website_cta` republishes a public site. Make both chat-only (not callable through the Agent API) and put a human gate on merge.
- **Verify:** readiness tests per channel (SMTP set or unset, gate off, no approved template); `create_form` blocks duplicate names; tenancy check passes.

**P3 — Website Build v2 (PORT, 7 PRs). Merges dark: prod has no `GITPAGE_API_KEY` and `websiteEnabledByAgency` stays off. Docs marked NOT runtime-verified.**

Shared-file churn is low throughout: `website-builder.tsx`, `types/website.ts`, `niches.ts`, `validation.ts`, the poll, poll-now and `[siteId]` routes, `refresh-kb` and the website page are all 0; `gitpage/client.ts` is 14; `websites-service.ts` is 30. The new `PAGESPEED_API_KEY` (optional) goes in `.env.example` and env-schema. No rules or index changes (all queries are equality-only).

| PR | Files | Lines |
|---|---|---|
| WS-1 types and pure libs | `types/website.ts` +633 (~340 types/helpers, ~290 niche samples), `lib/website/premium.ts` 288, `niches.ts` +45 (agency_consulting, ai_consulting, ai_automation), `validation.ts` +23 | ~990 |
| WS-2 client, settle, callback | `gitpage/client.ts` +246, `websites-service.ts` +269 (without hand-off), `poll` +31/−30, `poll-now` +13/−20, `[siteId]` PATCH draft +58, `website/concepts` route 62, `webhooks/gitpage/build-settled` 89, `middleware.ts` +3 (churn 443, additive) | ~770 |
| WS-3 hand-off on publish | `website-handoff-service.ts` 481 **without the voice branch**; email check switched from Resend to our SMTP check; new `src/lib/server/app-url.ts`; `refresh-kb` `{siteId}` +79 | ~600 |
| WS-4 after-publish tools | `[siteId]/domain` 144, `website-domain-dialog` 184, `pagespeed` route 50, `website-pagespeed.ts` 72, `website-seo-panel` 28, `website-edit-helper` 187, middleware pattern | ~670 |
| WS-5 form UI | `website-form-parts` 261, `website-premium-sections` 550 | ~810 |
| WS-6 wizard and card rewrite | `website-wizard` 876, `website-builder` +195/−1217, website `page.tsx` +36, getting-started copy | ~1,110 |
| WS-7 assistant | `list_website_concepts`, new `create_website` arguments, `check_website_status` stage and hand-off, KB | ~250 |

- **Verify:**
  - HMAC check on the build-settled callback (mutation test).
  - Settling is idempotent when the poll and the callback race.
  - `pollAttemptCapFor` / `pollDelayFor`.
  - The PATCH is refused while a build is in flight.
  - Hand-off steps run independently and record their errors.
  - The workflow is published only when a customer-facing step survives and QStash is set.
- **Merge:** WS-3 needs a Hein gate. It auto-publishes a speed-to-lead workflow that messages leads.

**P4 — Web Voice (ElevenLabs) (PORT, 4 PRs plus one gate PR). Merges dark behind `webVoiceEnabledByAgency`; docs marked NOT runtime-verified.**
- **G (shared with P5), ~180 lines:**
  - Two gates: `webVoiceEnabledByAgency` and **`dialerEnabledByAgency` (new; upstream has no dialer gate)**.
  - Wiring per docs/architecture/feature-gates.md:
    - `types/tenancy.ts` (churn 522)
    - `api/auth/signup` (177) and `sub-accounts-service` (335)
    - `feature-gates` route (253) and `feature-gates-service` `AgencyGateField` (116)
    - `sub-account-manage-dialog` (724)
    - `FEATURE_GATES` in `capabilities/helpers.ts` with `assistantMayEnable: false`
    - a row in the gates doc
  - Neither gate goes in `PLAN_GATE_KEYS`.
  - Note: the manage dialog has a known bug where a second Save silently reverts the first. Verify one gate at a time, in Firestore.
- **WV-1, connection backend (~890):** `types/web-voice.ts` 130, `lib/web-voice/elevenlabs.ts` 225, `web-voice-service.ts` 357 (imports `app-url.ts`), `api/sub-accounts/[id]/web-voice` 178.
- **WV-2, call path (~980):**
  - New files: `lib/web-voice/{tokens 98, rate-limit 34, speech 73}`, `web-voice-usage` 295, `web-chat/voice/start` 170, `web-chat/voice/event` 109, `webhooks/elevenlabs/llm/...` 135.
  - Edits: `web-chat/config` +23 (churn 21), voice mode in `web-chat/respond` +35 (80; **after P0**, which edits the same file), `session` +3 (44), middleware `/api/webhooks/elevenlabs`.
- **WV-3, settings card (~550):** `web-voice-section.tsx` 544, web-chat page +3.
- **WV-4, widget (~370):**
  - `chat-window` +~320 and `widget.js` (`vt` param, microphone permission) — **after N4**.
  - `web-chat/poll` +5, `web-chat-session-thread` +12 (churn 0), `conversation-thread` voice marker (churn 485).
  - Adds `@elevenlabs/client` to package.json.
- **WV-5 (~60):** `include_voice` and the hand-off voice branch, after WS-3 and WS-6.
- **Rules, env:** none (secrets go under the existing deny-all `private/*`). Needs a public https `NEXT_PUBLIC_APP_URL`.
- **Verify:** token HMAC and the path secret (mutation tests); cap and concurrency reservation inside a transaction; each call is settled once; voice mode drops `[[form]]`; gate off gives 403 and `voiceEnabled:false`. Live-check the negative path: the mic stays hidden while the gate is off.

**P5 — Softphone / browser dialer (PORT with a required change, 2 PRs after G). Merges dark behind `dialerEnabledByAgency`.**
- **SP-2, server (~680):**
  - `lib/comms/dialer.ts` 115, `api/sub-accounts/[id]/dialer` 199, `api/comms/dialer/token` 65, `webhooks/twilio/dialer/{twiml 132, status 110}`.
  - Types: `DialerConfig` and `DialerPrivateDoc` in `types/tenancy`; `call_placed` activity in `types/contacts` (churn 156).
  - **All auth-token reads go through `readSubAccountSecret`** (problem 1).
  - Gate check in the token, TwiML and provisioning routes.
  - Webhooks sit under the existing public `/api/webhooks/twilio` prefix, so no middleware change.
- **SP-3, UI (~470):** `browser-call-bar` 259, `sub-account-dialer-section` 160, `contact-profile-header` +35 (churn 109), `activity-timeline` +5 (367), settings page +3 (178), `@twilio/voice-sdk`.
- **Rules, env:** none.
- **Flag:** provisioning creates an API key and a TwiML App on the client's own Twilio account, which is an external action. Disabling should clean them up; confirm the behaviour.
- **Verify:** signature check against the private-doc token (mutation test); `voiceOptedOut` is blocked on the server; the dial target is resolved from the contact document, never from the client; recording defaults off; gate off gives 403.

**N2 — Assistant tool batch from upstream's 2026-09-08 release (PARTIAL: the services exist in ours, only the tool layer is missing)**
- **N2a, workspace tools (~580):** `pause_all_workflows` (56), `find_awaiting_payment_bookings` + `mark_booking_paid` (103), `list_communities` + `add_course` + `add_lesson` (250), `watchdog_status` + `configure_watchdog` (171; `upsertWatchdogConfig` exists at `agents-watchdog-service.ts:83`).
- **N2b, agency tools (~410):** `billing_overview`, `comp_client`, `resend_checkout_link`, `sub_account_usage`, `set_usage_limits`, `deployment_setup_status`. `compSubAccount`, `mintCheckoutLink`, `effectiveBillingState`, `getEffectiveQuotas` and `computeOverage` already exist in ours, adapted to Paystack. `deployment_setup_status` needs an `EXTERNAL_ONLY` exemption in `scripts/check-capability-tenancy.mjs` (churn 198).
- **Flag:** `comp_client` cancels a subscription, which is irreversible. Make it chat-only.

**Optional (each needs a decision before it's built)**
- **N7 Email AI drafts (~350).** Upstream's draft-only `"email"` channel: `agent.ts` (churn 125), `gates.ts` (18), `prompt.ts` (12), `respond.ts` (304), channels route (153), new `email-channel-section` 197, email AI page (0). It needs a new hook in our IMAP inbound path; today `email-conversations.ts` never calls `maybeRespondWithAi`. Upstream gates it on the Resend email-domain gate, so we would need a different gate. Optionally add the quoted-reply collapse (`lib/email-quote.ts` 87).
- **N8 Recreate GHL pipelines on import (~180).** `ghl/start` (22), `transform` (49), `bulk-write` (243), wizard (34). Low value now that we've left GHL.
- **N9 `GET /api/v1/pipelines` (34).** The Agent API already offers `list_pipelines`.
- **N10 Booking-editor "calendar connected" host chips (~55).** Needs a status our members can read; our Google Calendar connection data sits under `gcalConnectionPath`.
- **N11 Email-channel loose ends.** Add `email` to the push `CHANNEL_LABELS` (`push/events.ts:34`) and to the watchdog's `CHANNEL_COLLECTION` (`agents-watchdog-service.ts:155`). Check first whether inbound email emits `message.received`.
- **N12 KB refresh.** About 19 upstream cards, to be adapted for Paystack, WhatsApp Cloud/bridge and SMTP.
- **N13 Owner prompt section on fixing bugs with Claude Code (14 lines).**

---

### PR order, dependencies and parallel lanes

```
P0 runAfterResponse (in flight) ──► everything rebases after it merges
Lane E (independent, parallel after P0): N1 · N4 · N5 · N6 · N3 · P1
Lane A (one at a time, all edit the capabilities registry + KB):
        STL-1 ─► STL-2 ─► N2a ─► N2b ─► WS-7 ─► WV-5 (create_website arg)
Lane B (website): WS-1 ─► WS-2 ─┬─► WS-3 (also needs STL-1, for forms-service)
                                ├─► WS-4
                  WS-1 ─► WS-5 ─┴─► WS-6 (needs WS-2) ─► WS-7
Lane C (dialer):  G ─► SP-2 ─► SP-3
Lane D (voice):   G + WS-3 (app-url) ─► WV-1 ─► WV-2 ─► WV-3 ─► WV-4 (needs N4) ─► WV-5 (needs WS-6)
```

**Changes to the order you proposed (P0 → snapshot → STL → Website v2 → Web Voice → dialer):**
- N1 goes right after P0, in parallel with P1. It's a live correctness bug.
- The dialer doesn't need to wait until the end. Its files don't overlap with the website or voice work; it shares only the gate files, so the two gates go into one PR (G) to avoid six-file conflicts.
- STL must come before WS-3, because the hand-off needs `forms-service`. Web Voice must come after WS-3 (the `app-url` module and the hand-off voice branch). Both of these match your order.

**Expect small rebases where parallel PRs touch the same file:**
- `middleware.ts`: WS-2, WS-4, WV-2
- `types/tenancy.ts`: G, SP-2, WV-1
- `env-schema.mjs`: P1, WS-4
- `package.json` / lockfile: SP-3, WV-4 — merge these one at a time
- `websites-service.ts`: STL-2, WS-2, WS-3
- `knowledge-base.ts`: lane A and the feature PRs

**Size and merge gate per PR.** "Hein gate" means Hein reads the diff before merge. "Eligible" means the CLAUDE.md conditions for merging on green CI plus a blind review without Hein reading the diff can be met (greenfield or additive, not customer-facing, no client data, tested).

| PR | Lines | Merge |
|---|---|---|
| P1 | 380 | eligible |
| N1 | 200 | Hein gate |
| N3 | 650 | Hein gate |
| N4 | 110 | Hein gate |
| N5 | 65 | eligible |
| N6 | 120 | eligible |
| G | 180 | eligible |
| STL-1 | 350 | Hein gate |
| STL-2 | 450 | Hein gate |
| N2a | 580 | eligible |
| N2b | 410 | Hein gate |
| WS-1 | 990 | eligible |
| WS-2 | 770 | eligible |
| WS-3 | 600 | Hein gate |
| WS-4 | 670 | eligible |
| WS-5 | 810 | eligible |
| WS-6 | 1,110 | eligible |
| WS-7 | 250 | eligible |
| WV-1 | 890 | Hein gate |
| WV-2 | 980 | Hein gate |
| WV-3 | 550 | eligible |
| WV-4 | 370 | Hein gate |
| WV-5 | 60 | Hein gate |
| SP-2 | 680 | Hein gate |
| SP-3 | 470 | Hein gate |

That is about 12,700 added lines over 25 core PRs. Production deploys stay after-hours with Hein's explicit go.

---

### Decisions for Hein
1. **Upstream files over 300 lines.** `website-wizard` (876), `website-premium-sections` (550), `web-voice-section` (544), `website-handoff-service` (481), `web-voice-service` (357). The global rule caps files at 300 lines, but the repo's linter doesn't enforce it. Recommendation: split the server files at clean seams and port the UI components close to upstream's code. The best argument against splitting: past fix rounds introduced defects, and a faithful port is less risky.
2. **Should the dialer get a gate?** Recommendation: yes, `dialerEnabledByAgency` defaulting to off, in line with "merge dark". Upstream deliberately shipped without one.
3. **Optional N7 (Email AI drafts) and N8 (GHL pipeline import):** build them or not?

### feature_list.json
```json
{"project":"crestahq-upstream-port-1.0.40","planned_at":"2026-10-10","tech_stack":["Next.js 15","TypeScript","Firestore","QStash","Twilio","ElevenLabs","gitpage"],"last_session":null,"features":[
{"id":"p0-run-after-response","priority":0,"complexity":"medium","success_criteria":["in flight elsewhere"],"passes":false},
{"id":"n1-pipeline-terminal-sweep","priority":1,"complexity":"low","success_criteria":["AI context excludes custom-pipeline Won deals from Active","leads-map/quote-builder/palette/dashboard use per-pipeline terminals","tests fail when dealOutcome is mutated"],"passes":false},
{"id":"p1-setup-snapshot-dialog","priority":1,"complexity":"low","success_criteria":["summary.groups has no key names","dismissal stored in users/{uid}/settings, no rules change","owner-only show rule tested","live walk on prod"],"passes":false},
{"id":"n4-webchat-contrast","priority":1,"complexity":"low","success_criteria":["textOnAccent unit-tested","widget bubble readable on yellow accent"],"passes":false},
{"id":"n5-chart-axes","priority":2,"complexity":"low","success_criteria":["y-axis labels and tooltips render; currency formatting on Won chart"],"passes":false},
{"id":"n6-small-fixes","priority":2,"complexity":"low","success_criteria":["no sr-only phantom scrollbar","resend status syncs on GET","metadataBase falls back safely","done groups collapse"],"passes":false},
{"id":"n3-style-presets","priority":2,"complexity":"medium","success_criteria":["unknown preset rejected","null preset byte-identical","Playwright on /b and /co"],"passes":false},
{"id":"g-gates-webvoice-dialer","priority":2,"complexity":"low","success_criteria":["both gates default false at both creation sites","PATCH, dialog and FEATURE_GATES wired","assistantMayEnable false"],"passes":false},
{"id":"stl-1-forms-workflow","priority":3,"complexity":"medium","success_criteria":["forms-service mirrors UI presets","list_forms/create_form/test_workflow pass check:tenancy","test_workflow chat-only"],"passes":false},
{"id":"stl-2-readiness-cta","priority":3,"complexity":"medium","success_criteria":["readiness uses SMTP and our WA rails","update_website_cta chat-only","prompt section renders only with actions"],"passes":false},
{"id":"n2a-workspace-capabilities","priority":4,"complexity":"medium","success_criteria":["9 tools anchored on ctx.subAccountId","confirm-gated writes"],"passes":false},
{"id":"n2b-agency-capabilities","priority":4,"complexity":"medium","success_criteria":["Paystack-correct billing_overview","comp_client chat-only","deployment_setup_status exempted in tenancy script"],"passes":false},
{"id":"ws-1-types-libs","priority":5,"complexity":"medium","success_criteria":["premium parse/validate tests","addressOptional niches"],"passes":false},
{"id":"ws-2-client-settle-callback","priority":5,"complexity":"high","success_criteria":["HMAC mutation test","idempotent settle on race","poll cap/backoff"],"passes":false},
{"id":"ws-3-handoff","priority":5,"complexity":"high","success_criteria":["no Resend dependency","steps independent and idempotent","workflow published only when sendable and QStash set"],"passes":false},
{"id":"ws-4-domain-pagespeed-edit","priority":6,"complexity":"medium","success_criteria":["www/apex allowlist","pagespeed QStash-signed"],"passes":false},
{"id":"ws-5-form-ui","priority":6,"complexity":"medium","success_criteria":["premium sections render; validation keys map to steps"],"passes":false},
{"id":"ws-6-wizard-card","priority":6,"complexity":"high","success_criteria":["draft saved per step","no Rebuild on live sites","docs NOT runtime-verified"],"passes":false},
{"id":"ws-7-assistant","priority":6,"complexity":"low","success_criteria":["list_website_concepts; create_website premium args"],"passes":false},
{"id":"wv-1-connection","priority":7,"complexity":"high","success_criteria":["key probed before store","secret only in private/","app-url extracted"],"passes":false},
{"id":"wv-2-call-path","priority":7,"complexity":"high","success_criteria":["token and path-secret mutation tests","cap reservation transactional","gate off gives 403"],"passes":false},
{"id":"wv-3-card","priority":7,"complexity":"medium","success_criteria":["locked state when gate off"],"passes":false},
{"id":"wv-4-widget","priority":7,"complexity":"medium","success_criteria":["mic hidden when voiceEnabled false (live-checkable)","SDK lazy-loaded"],"passes":false},
{"id":"wv-5-website-voice","priority":8,"complexity":"low","success_criteria":["hand-off never turns voice off"],"passes":false},
{"id":"sp-2-dialer-server","priority":7,"complexity":"high","success_criteria":["authToken via readSubAccountSecret","signature mutation test","voiceOptedOut blocked server-side","gate enforced"],"passes":false},
{"id":"sp-3-dialer-ui","priority":7,"complexity":"medium","success_criteria":["Call button only when dialerConfig.enabled and gate on","call_placed timeline row"],"passes":false}]}
```
---

### Hein's rulings (2026-10-10)
1. Files over 300 lines: **port verbatim** — keep upstream's file shapes (no splitting), for both server and UI.
2. Dialer: **gated** — `dialerEnabledByAgency`, default off (unit G).
3. Optional extras: **N7 Email AI drafts, N8 GHL pipeline import, N12 KB card refresh are IN scope.** N9/N10/N11/N13 remain optional.
4. Merge-dark rule: Web Voice, Website v2 and dialer merge behind their gate, default off, docs marked NOT runtime-verified; first client to enable triggers a live walk.
