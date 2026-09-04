# Project Structure

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*
```
src/
  app/
    (auth)/                       Login + Signup pages
    (legal)/                      Terms of Service + Privacy Policy
    (embed)/                      Iframe-able routes that bypass dashboard chrome
      embed/chat/[subAccountId]/  AI Agents Web Chat widget iframe target
    (dashboard)/                  Protected pages
      agency/                     Agency landing + sub-account picker
        get-started/              First-run onboarding (after agency owner signup)
        sub-accounts/             List + create new sub-account
      sa/[subAccountId]/          Per-sub-account CRM (the working surface)
        dashboard/                Home: KPI summary + pipeline snapshot + activity
        dashboard/settings/       Profile, theme, subscription, members, SMS, send-window
        contacts/                 List + [id] profile (notes, activities, send email/SMS)
        pipeline/                 6-stage Kanban (drag-drop deals)
        calendar/                 Month grid + events
        tasks/                    Today / Overdue / Upcoming / Done
        forms/                    Builder list + [id] editor (drag-order fields, mapsTo)
        quotes/                   List + new + [id] detail/edit (operator-facing quote flow)
        reports/                  Date-range KPIs + funnel + charts
        workflows/                Visual automation builder (list + [workflowId] editor + runs). The legacy automations/ pages (incl. its Settings) were REMOVED — Reply-To / send window / pause-all now live in Settings → Sending preferences
        broadcasts/               Bulk-email list + [id] detail (live status)
        social/                   Social Planner — content calendar + post list + composer + Connections tab (agency-gated)
        website/                  gitpage.site builder (long sectioned form)
        ai-agents/                Shared persona + KB (Overview) + per-channel pages
          (page.tsx)              Overview: AgentProfileSection + channel status grid
          web-chat/               Web Chat settings (toggle, theme, allowed domains, snippet)
          web-chat/sessions/      Live operator console — list + [sessionId] transcript
          sms/                    SMS channel settings (toggle, model, escalation)
          whatsapp/               WhatsApp channel settings (toggle, escalation)
          whatsapp/templates/     WhatsApp template manager (gallery + builder + approval status)
          voice/                  Inbound Voice channel settings (Vapi number mode, greeting, voice)
          voice/calls/            Voice operator console — list + [callId] call summary + transcript
          outbound/               Outbound Voice — click-to-call config + campaign launcher
          outbound/campaigns/     Campaign list + [campaignId] per-recipient status
          email/ google-business/ Hidden coming-soon placeholders (pages resolve if hit directly)
      contacts/ dashboard/ ...    Legacy flat routes — redirect to the first sub-account
    f/[formId]/                   Public hosted form (unauthenticated)
    q/[token]/                    Public quote view + accept/decline landing (unauthenticated, HMAC-token-gated)
    u/[token]/                    Public unsubscribe landing (unauthenticated)
    thank-you/                    Post-signup landing
    api/
      auth/signup/                Create user; first-signup bootstrap mints agency + Main SA
      auth/refresh-claims/        Re-mint custom claims after membership changes
      agency/                     PATCH agency, list/create sub-accounts, gitpage-status refresh
      sub-accounts/[id]/
        invite/                   Create + accept member invites
        members/[uid]/            Update role / revoke access
        twilio/                   Save dedicated Twilio creds (auto-wires inbound webhook)
        website/                  POST create-site (cap-enforced); [siteId]/build|poll|
        website/[siteId]/...      poll-now|DELETE (reset via ?reset=1, else remove)
      contacts/[id]/              DELETE contact + subcollections + referencing deals/tasks
      forms/[id]/submit/          Public form submission (unauthenticated; admin SDK)
      comms/email/send/           Send email (Resend, shared-sender)
      comms/sms/send/             Send SMS (Twilio, env-var or per-SA dedicated)
      automations/step/           QStash callback — executes one Speed-to-Lead step
      broadcasts/email/send/      Initiate bulk email (validate + fan out to QStash)
      broadcasts/email/step/      QStash callback — sends one recipient's email
      u/[token]/                  POST unsubscribe (flips contact.emailOptedOut)
      cron/gitpage-heartbeat/     Daily QStash-scheduled gitpage subscription-status refresh
      webhooks/stripe/            Stripe subscription webhook
      webhooks/twilio/inbound/    Inbound SMS (STOP/START opt-out + chat-thread writes + AI auto-reply)
      sub-accounts/[id]/
        ai-agent/profile/         GET/PATCH shared agent profile (persona, hours, KB)
        ai-agent/profile/         POST refresh-kb → Firecrawl scrape of websiteUrl
          refresh-kb/
        ai-agent/channels/        GET/PATCH per-channel config (enabled, model, overrides)
          [channel]/
        ai-agent/test/            POST dry-run the persona against a test message
      web-chat/config/            GET widget config (theme + welcome). Origin-gated.
      web-chat/message/           POST visitor message → bot reply. Rate-limited.
      web-chat/capture/           POST inline-form submit → Contact + Task + escalation email
      sub-accounts/[id]/
        quotes/                   POST create draft quote (issues atomic per-SA sequence number)
        quotes/[quoteId]/send/    POST send/re-send quote (issues fresh HMAC token, sends email)
        quotes/[quoteId]/mark-paid/  POST flip accepted → paid (manual; no payment collection in v1)
      quotes/[token]/respond/     POST anonymous accept/decline (HMAC-token-gated, txn-wrapped)
      dev-only/danger-wipe-       DEV TESTING ONLY — wipes everything in the agency
        everything/               (owner-gated; not for production use)
  components/
    ui/                  shadcn/ui primitives
    auth/                Login + signup forms
    landing-custom/      White-label marketing page (navbar, hero, features, pricing, FAQ, CTA, footer)
    brand/               Brand mark / logo components
    agency/              Agency landing + sub-account picker UI
    dashboard/           Sidebar + Header (dynamic title + Cmd+K trigger + SA switcher)
    contacts/            Table, profile, activity timeline, send-email/sms + bulk-email dialogs
    pipeline/            Board, deal card, new-deal + lost-reason dialogs
    calendar/            Month view + event dialog
    tasks/               Task item + task dialog
    forms/               Public form renderer + builder pieces
    quotes/              quote-builder (line-item editor + live totals), quote-list (filter chips + search), quote-detail (view/edit + Send/Mark-paid/Delete), quote-status-badge, public-quote-view (recipient accept/decline + reason picker)
    reports/             SVG chart primitives
    automations/         Recipe attach UI, template editor, history viewer
    ai-agents/           Channel nav tabs + AgentProfileSection (persona+KB) + SMS/WebChat channel sections + WebChatSessionsList + WebChatSessionThread
    web-chat/            ChatWindow component rendered inside the embed iframe (self-contained, immune to host CSS)
    social/              Social Planner: social-content-calendar (month grid of posts), social-post-composer (caption + image URL + FB/IG targets + schedule dialog), social-connections (read-only status + deep link to Settings)
    analytics-scripts.tsx  Crisp/GTM/Pixel loader — skips on /embed/* so the chat iframe doesn't render a nested support widget
    search/              Cmd+K command palette
    settings/            Sub-account members + per-SA Twilio config sections
  config/
    landing.ts           CUSTOM_BRAND fields (white-label config)
  lib/
    firebase/            Client + admin SDK (admin uses "server-only" guard) + auth helpers
    stripe/              Checkout + portal + webhooks + client/server helpers
    comms/               Resend + Twilio wrappers, route-auth, usage counter, SMS segments, per-SA config; meta.ts (server-only Graph API: OAuth, scopes, granted-scope read, send + Social Planner publish helpers), meta-capabilities.ts (client-safe metaCanInbox/metaCanPublish/deriveMetaCapabilities)
    comms/ai/            AI Agents: agent.ts (profile + per-channel resolver + lazy migration), respond.ts (SMS orchestrator), prompt.ts (channel-aware system prompt + KB injection), context.ts (contact context block), escalation.ts (keyword match + email notify), openrouter.ts (LLM client)
    comms/web-chat/      Web Chat: session.ts (get-or-create + history + capture-state), respond.ts (orchestrator returning reply over HTTP), capture.ts (parse [[form]] + [[capture]] markers, Contact reconciliation), follow-up.ts (post-capture Task + escalation email), origin.ts (Origin allowlist), rate-limit.ts (in-memory IP + session caps)
    firecrawl/           client.ts — agency-level scrape wrapper (/v1/scrape, 30s timeout, FirecrawlError)
    firestore/           CRUD helpers per collection (contacts, deals, tasks, events, forms, quotes, activities, users, mail, web-chat-sessions, social-posts)
    quotes/              calc.ts (pure money math + isQuoteExpired), token.ts (HMAC + nonce public-share token, only SHA-256 hash persisted), number.ts (atomic Q-YYYY-NNNN sequence per sub-account), email.ts (recipient email subject + text + html), lifecycle.ts (recordQuoteActivity + fireQuoteTrigger + autoCreateDealForAcceptedQuote — side-effects swallow errors so they can't break the primary write)
    automations/         triggers, executor, qstash, merge-tags, unsubscribe-token, seed-templates, template-presets
    broadcasts/          audience.ts (filter resolution for bulk email recipients)
    contacts/            location.ts (IP geo via ipapi.co + phone country-code parsing + country centroids)
    landing/             resolve-brand.ts (server-side: merges agency doc over CUSTOM_BRAND for the custom landing)
    gitpage/             client.ts (gitpage REST SDK) + heartbeat.ts (subscription status cache)
    website/             gitpage-values.ts (curated dropdown values), niches.ts, validation.ts
    forms/               Form appearance/styling helpers
    auth/                require-admin, require-tenancy guards
    health/              Liveness checks (incl. OpenRouter + Firecrawl checks under the ai-agents category)
    attribution.ts       readAttributionFromBrowser() + trackLeadEvent() — captures UTM/fbclid/gclid/referrer/landing-page from URL params and fires Meta Pixel Lead event on form submit
    crisp.ts             openCrispChat() — typed wrapper around the global $crisp queue; safe no-op when the widget isn't loaded
    csv.ts               CSV parse + serialize + contact-field fuzzy matcher
    format.ts            Date / relative-time / currency formatters
    utils.ts             cn() class merger
  hooks/                 useAuth, useSubAccount, useDueTodayCount, etc.
  context/               AuthContext + SubAccountContext providers
  types/                 Per-domain TypeScript types
  middleware.ts          Auth gating (next-firebase-auth-edge); PUBLIC_PATHS + PUBLIC_PATH_PATTERNS (includes /api/web-chat + /embed + /widget.js)
public/widget.js         Vanilla JS widget loader (~4KB). Snippet on the buyer's clients' sites pulls this file; it injects a floating bubble + lazy-loads the iframe pointing at /embed/chat/[saId].
next.config.ts           Headers config — CSP frame-ancestors * for /embed/* so the chat iframe loads cross-origin; CORS + cache-control on /widget.js.
instrumentation.ts       Cold-start gitpage status ping
firestore.rules          Tenancy + role-based security rules
firebase.json            Deploys firestore.rules only
```

