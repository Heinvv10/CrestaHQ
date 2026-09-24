import type { StripeConnectionMeta } from "@/types/payments";
import type { GbpWidgetMeta, GoogleConnectionMeta, GoogleListing } from "@/types/google";
import type { PaystackConnectionMeta } from "@/types/paystack-connection";
import type { Webinar1ConnectionMeta } from "@/types/webinar1";
import type { WhatsappCloudMeta } from "@/types/whatsapp-cloud";
import type { WhatsappBridgeMeta } from "@/types/whatsapp-bridge";
import type { WhatsAppSender } from "@/types/whatsapp-senders";

export type AgencyRole = "owner" | "staff";
export type SubAccountRole = "admin" | "collaborator";
export type SubAccountStatus = "active" | "archived";

/**
 * Dashboard accent theme (Agency → Settings → App theme). Drives the
 * `--primary`/`--ring` CSS variables via a class on <html> (see
 * globals.css + components/theme/app-accent.tsx):
 *   - "leadstack" — indigo/violet, the LeadStack design language
 *   - "green"     — the emerald "my CRM" palette from the custom landing
 *   - "neutral"   — stock zinc monochrome
 * Unset defaults per deployment mode: "green" when LANDING_VARIANT is
 * "custom", "neutral" on the LeadStack demo (so demo branding never
 * changes unprompted).
 */
export type AppTheme = "leadstack" | "green" | "neutral";

import type { Timestamp, FieldValue } from "firebase/firestore";
import type { SubscriptionStatus, MemberStatus } from "./firebase";

export interface AiModelPolicy {
  /** OpenRouter model ids the owner ticked. The app default is always allowed. */
  allowedModels: string[];
  /** USD per 1M input tokens; null = no ceiling. */
  maxPromptPerM: number | null;
  /** USD per 1M output tokens; null = no ceiling. */
  maxCompletionPerM: number | null;
}

export interface AgencyDoc {
  id: string;
  name: string;
  ownerUid: string;
  createdAt: Date;
  updatedAt: Date;
  // Billing lives at agency scope.
  stripeCustomerId: string | null;
  subscriptionStatus: SubscriptionStatus;
  subscriptionPriceId: string | null;
  /**
   * Optional URL of the agency's logo. When set, the dashboard sidebar +
   * browser tab title swap LeadStack's chevron mark + wordmark for the
   * agency's brand. The URL is rendered as <img src="…" />, so any public
   * https URL works (CDN, S3, the agency's own site). Null = LeadStack's
   * default mark.
   */
  logoUrl: string | null;
  /**
   * Public support / contact email for the agency. Surfaced on the custom
   * landing page ("Talk to us" CTAs, FAQ "email us" line, footer). Null
   * falls back to CUSTOM_BRAND.supportEmail from src/config/landing.ts.
   */
  supportEmail: string | null;
  /**
   * Agency's public domain — used in landing footer + canonical URL. No
   * scheme, no trailing slash (e.g. "leadmachine.com"). Null falls back to
   * CUSTOM_BRAND.primaryDomain.
   */
  primaryDomain: string | null;
  /**
   * Dashboard accent theme. Null/undefined = mode default (see
   * {@link AppTheme}). Owner-set via Agency → Settings → App theme.
   */
  appTheme?: AppTheme | null;
  /**
   * Agency policy: may sub-accounts fall back to the SHARED (deployment-wide,
   * env-var) Twilio sender for SMS? Default ON — `undefined`/`true` means
   * allowed, so legacy agencies are unaffected. When explicitly `false`, the
   * shared fallback is refused and a sub-account must configure its own
   * dedicated Twilio number to send SMS. Enforced at the single send chokepoint
   * (`getTwilioForSubAccount`) and reflected in the workflow builder readiness.
   */
  sharedSmsAllowed?: boolean;
  /**
   * Which OpenRouter models sub-accounts may pick for AI Agents channels.
   * Absent = never saved: every model already in use stays allowed, and the
   * settings page pre-ticks those plus the app default. Owner-set via
   * Agency → Settings → AI model. See lib/comms/ai/model-policy.ts.
   */
  aiModelPolicy?: AiModelPolicy | null;
  /**
   * Master switch for the Agency Assistant (the owner-level AI at
   * /agency/ai-suite). OFF by default — read `=== true`, so legacy docs
   * (undefined) stay off until the owner enables it under Agency → Settings.
   * Gated because every reply spends the deployment's OpenRouter credits.
   * While off: the sidebar entry is hidden, the page shows an enable prompt,
   * and the agency-level chat/confirm routes 403. Orthogonal to the
   * per-sub-account `aiSuiteEnabledByAgency` gate (Workspace Assistant).
   */
  agencyAssistantEnabled?: boolean;
  /**
   * Which model tier the Agency Assistant runs on (see
   * {@link AiSuiteModelChoice}). Unset/legacy reads as "opus" — matching
   * pre-picker behavior. Written by PATCH /api/agency alongside the
   * enable switch.
   */
  agencyAssistantModel?: AiSuiteModelChoice;
}

/**
 * Model tier for the AI Suite assistants (Agency + Workspace). Stored as a
 * friendly key (not an OpenRouter slug) so the slug mapping lives in ONE
 * place server-side (lib/ai-suite/model.ts) and can change without touching
 * tenant docs. Unset/legacy reads as "opus" — matching pre-picker behavior,
 * so upgrading deployments keep the model they had; Sonnet is the opt-down
 * for cost.
 */
export type AiSuiteModelChoice = "opus" | "sonnet";

export interface SubAccountDoc {
  id: string;
  agencyId: string;
  /**
   * Sequential, human-readable identifier per agency. Assigned at creation
   * via a counter doc at agencies/{agencyId}/counters/subAccount, starting
   * at 1000 (so Main = 1000, next = 1001, ...). Doc IDs in URLs are still
   * Firestore auto-IDs; this number is a UI-only label.
   */
  accountNumber: number;
  name: string;
  slug: string;
  status: SubAccountStatus;
  timezone: string;
  /**
   * ISO-3166 alpha-2 country used as the FALLBACK when parsing a phone
   * number typed without a country code (see lib/contacts/phone.ts).
   * Undefined/null reads as "US". Never a restriction — "+"-prefixed
   * numbers always parse as their own country.
   */
  defaultPhoneCountry?: string | null;
  /**
   * Per-workspace usage-quota OVERRIDE (Usage Metering v1). Wins over the
   * assigned plan's quotas; null/absent falls through to the plan, then
   * unlimited. Agency-owner-only writes via the feature-gates PATCH.
   */
  usageQuotas?: import("./usage").UsageQuotas | null;
  /**
   * Per-workspace overage-rate OVERRIDE (v1.5) — same resolution shape as
   * `usageQuotas` but for the sell rates. See UsageRates.
   */
  usageRates?: import("./usage").UsageRates | null;
  createdByUid: string;
  createdAt: Date;
  updatedAt: Date;
  // Reserved for the upcoming Workflow Recipes feature. Populated null/empty in
  // v1; the per-sub-account credential UI lands when Workflows ships.
  twilioConfig: TwilioConfig | null;
  /**
   * Per-sub-account dedicated email sending domain (platform-managed model).
   * When `status === "verified"`, email sent on behalf of this sub-account
   * goes out from `emailFrom` on the tenant's own verified (sub)domain — all
   * through the agency's single shared Resend account/API key, varying only
   * the From address. Null (or any non-verified status) falls back to the
   * deployment-wide EMAIL_FROM shared sender, preserving v1 behavior.
   * Orthogonal to `replyToEmail`, which only sets the Reply-To header.
   */
  resendConfig: ResendConfig | null;
  /** Unset preserves shared Resend. SMTP credentials are server-only. */
  emailProvider?: "resend" | "smtp";
  smtpConfig?: import("./email").SmtpMeta | null;
  /**
   * Agency-controlled gate for the dedicated email sending domain feature.
   * Only the agency owner can flip this (PATCH /api/agency/sub-accounts/[id]/
   * feature-gates). When `false`, sub-account admins CAN'T register or verify
   * a sending domain — the settings card shows a locked state, and the
   * POST/verify routes return 403. `tenantFrom()` also short-circuits on a
   * falsy gate, so sending falls back to the shared EMAIL_FROM even if a
   * verified resendConfig somehow persists. Defaults to `false` at creation
   * (explicit allowlist). May be undefined on docs created before the gate
   * shipped — read `=== true` so legacy docs stay locked.
   */
  emailDomainEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for the public API (slice 1-9 v1). Only the
   * agency owner can flip this (PATCH /api/agency/sub-accounts/[id]/
   * feature-gates). When `false` (or undefined on legacy docs): every
   * `/api/v1/*` request from this sub-account's keys returns 403
   * `api_access_disabled`, AND new keys / webhook subscriptions can't be
   * minted. Existing keys + subscriptions are PRESERVED — flipping the
   * gate back on resumes them instantly (vs the email gate which tears
   * down the verified Resend domain). Defaults to `false` at creation
   * (explicit allowlist). Read `=== true` so legacy docs stay locked.
   */
  apiAccessEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for bulk email broadcasts. When `false` (or
   * undefined on legacy docs): the broadcasts send route returns 403 and
   * the sidebar's Broadcasts entry renders as a disabled "Locked" item
   * the sub-account admin can't click. Defaults to `false` at creation
   * (explicit allowlist) so a tenant can't accidentally blast 25k emails
   * before the agency owner has signed off on the feature. Disabling does
   * NOT delete historical broadcast docs — re-enabling restores full
   * functionality immediately. Read `=== true` so legacy docs stay locked.
   */
  broadcastsEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for outbound AI voice calling (operator-
   * initiated click-to-call). When `false` (or undefined on legacy docs)
   * the /api/comms/voice/call route returns 403 and the Voice settings'
   * Outbound subsection renders a "Locked by your agency" state. Gated
   * separately from inbound voice because outbound consumes Vapi minutes
   * proactively and carries compliance weight. No tear-down on disable —
   * the linked assistant/number are shared with inbound. Defaults to
   * `false` at creation (explicit allowlist). Read `=== true`.
   */
  outboundVoiceEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for the WhatsApp channel (Twilio-delivered).
   * Only the agency owner can flip this (PATCH /api/agency/sub-accounts/[id]/
   * feature-gates). When `false` (or undefined on legacy docs): the WhatsApp
   * AI channel can't be enabled (channels route 403s), the inbound WhatsApp
   * webhook ignores messages for this sub-account, and the channel settings
   * card renders a "Locked by your agency" state. No tear-down on disable —
   * the sub-account's Twilio creds + sender number are preserved (shared with
   * SMS), so re-enabling resumes instantly. Defaults to `false` at creation
   * (explicit allowlist). Read `=== true` so legacy docs stay locked.
   */
  whatsappEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for the SMS AI auto-reply channel. Only the agency
   * owner can flip this (PATCH /api/agency/sub-accounts/[id]/feature-gates).
   * When `false` (or undefined on legacy docs): the SMS AI channel can't be
   * enabled (channels route 403s), the inbound Twilio webhook does NOT dispatch
   * an AI reply for this sub-account, and the SMS channel card renders a
   * "Locked by your agency" state. Gated because every auto-reply spends the
   * agency's shared OpenRouter credits. This gate governs the AI auto-reply
   * ONLY — manual SMS sends (the contact-profile Send button, shared sender)
   * are unaffected. No tear-down on disable — the sub-account's Twilio creds +
   * persona are preserved, so re-enabling resumes instantly.
   *
   * DEFAULT ON (opt-OUT). Unlike the resource gates above, the SMS AI channel
   * PRE-EXISTED this gate (it was always available), so undefined reads as ON —
   * `aiChannelGateOn()` returns the channel default for a missing field. This
   * keeps upgrading deployments from silently cutting off a running bot; the
   * agency flips it to explicit `false` to lock it. Creation writes `true`.
   */
  smsAgentEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for the Web Chat AI channel (the embeddable widget).
   * Only the agency owner can flip this (PATCH /api/agency/sub-accounts/[id]/
   * feature-gates). When `false` (or undefined on legacy docs): the channel
   * can't be enabled (channels route 403s), `/api/web-chat/config` returns
   * `{enabled:false}` so the widget loader silently no-ops on the client's
   * site, `/api/web-chat/message` 403s, and the Web Chat channel card renders a
   * "Locked by your agency" state. Gated because every visitor exchange spends
   * the agency's shared OpenRouter credits. No tear-down on disable — the
   * channel config + session history are preserved, so re-enabling resumes
   * instantly.
   *
   * DEFAULT ON (opt-OUT) — the Web Chat channel pre-existed this gate, so
   * undefined reads as ON (via `aiChannelGateOn()`) and upgrades don't cut off
   * a live widget. The agency flips it to explicit `false` to lock it.
   * Creation writes `true`.
   */
  webChatEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for the INBOUND Voice AI channel (Vapi-answered
   * calls). Only the agency owner can flip this (PATCH /api/agency/sub-accounts/
   * [id]/feature-gates). When `false` (or undefined on legacy docs): the Voice
   * channel can't be enabled (channels route 403s, so no Vapi assistant/number
   * is provisioned), the per-turn Vapi LLM webhook 403s inbound calls, and the
   * Voice channel card renders a "Locked by your agency" state. Gated — like
   * the sibling `outboundVoiceEnabledByAgency` — because it spends both Vapi
   * minutes and OpenRouter tokens. No tear-down beyond the channel's own
   * disable (which frees the Vapi resources). Outbound voice remains
   * independently gated.
   *
   * DEFAULT ON (opt-OUT) — inbound Voice pre-existed this gate, so undefined
   * reads as ON (via `aiChannelGateOn()`) and upgrades don't cut off a
   * provisioned line. The agency flips it to explicit `false` to lock it.
   * Creation writes `true`. (Outbound Voice stays opt-IN / default OFF.)
   */
  inboundVoiceEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for the BETA Facebook Messenger + Instagram DM
   * unified-inbox channels (both ride one Meta connection, so they flip
   * together). Only the agency owner can flip this (PATCH
   * /api/agency/sub-accounts/[id]/feature-gates). When `false` (or undefined
   * on legacy docs — the default for every existing sub-account) the feature
   * is INERT and INVISIBLE: no Meta inbound webhook, send route, settings, or
   * channel badge surfaces anywhere. This gate is the master switch for a
   * feature that can't be fully self-tested without a connected Meta account,
   * so it ships off and an agency lights it up only for a sub-account that has
   * the Meta setup and volunteers to beta-test. No tear-down on disable —
   * nothing is provisioned until the consumer slices land. Read `=== true` so
   * legacy docs stay locked. See the "Facebook + Instagram inbox" plan.
   */
  metaInboxEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for the Messenger + Instagram AI auto-reply (the
   * "meta" AI channel). Layered ON TOP of `metaInboxEnabledByAgency` — the
   * inbox gate makes the DMs exist, this gate lets the AI answer them
   * (spending the agency's shared OpenRouter credits). Opt-IN like WhatsApp
   * (`=== true`; the channel never pre-existed the gate). Enforced at
   * enable time (channels PATCH route) and at runtime (Meta inbound
   * webhook dispatch) via `lib/comms/ai/gates.ts`.
   */
  metaAgentEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for the website builder (gitpage.site). Only the
   * agency owner can flip this (PATCH /api/agency/sub-accounts/[id]/
   * feature-gates). When `false` (or undefined on legacy docs): the website
   * build route 403s and the Website sidebar entry renders a "Locked by your
   * agency" state. No tear-down on disable — the existing website config +
   * published site are preserved, so re-enabling resumes instantly. Builds
   * consume the agency's shared gitpage build quota (30/hour), which is why
   * it's agency-controlled. Defaults to `false` at creation (explicit
   * allowlist). Read `=== true` so legacy docs stay locked.
   */
  websiteEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for the Social Planner (schedule + auto-publish
   * posts to the connected Facebook Page / Instagram Business via the shared
   * `metaConfig` connection). Only the agency owner can flip it (PATCH
   * /api/agency/sub-accounts/[id]/feature-gates). When `false` (or undefined
   * on legacy docs): the Social Planner sidebar entry renders a "Locked by
   * your agency" state, the connect/create/publish routes 403, and the whole
   * surface stays invisible. No tear-down on disable — scheduled posts +
   * the Meta connection are preserved, so re-enabling resumes instantly.
   * Defaults to `false` at creation (explicit allowlist). Read `=== true` so
   * legacy docs stay locked. Posting reuses the same Meta App Review-gated
   * connection as the inbox, plus the extra publish scopes requested at
   * connect time. See the "Social Planner v1" plan.
   */
  socialPlannerEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for Get Leads (EXPERIMENTAL) — the local-business
   * prospecting tool (Outscraper-powered Google Maps search + enrichment,
   * results on a Mapbox map, select-and-import into Contacts). Only the
   * agency owner can flip it (PATCH /api/agency/sub-accounts/[id]/
   * feature-gates). When `false` (or undefined on legacy docs): the Get Leads
   * sidebar entry renders a "Locked by your agency" state and the
   * search/poll/import routes 403. Gated because every search spends the
   * agency's shared Outscraper credits. No tear-down on disable — results are
   * ephemeral and imported contacts are ordinary contacts. Defaults to
   * `false` at creation (explicit allowlist). Read `=== true` so legacy docs
   * stay locked.
   */
  getLeadsEnabledByAgency?: boolean;
  /**
   * Get Leads: operator-defined custom service types shown in the business-
   * type picker alongside the curated list. Plain display labels (each
   * doubles as the Google Maps query, ≤60 chars, ≤30 entries). Written only
   * by PUT /api/sub-accounts/[id]/get-leads/types (sub-account admin), and
   * read by the search route as part of the query allowlist. Absent = no
   * custom entries.
   */
  getLeadsCustomTypes?: string[];
  /**
   * Get Leads: curated business-type VALUES (e.g. "restaurant") the operator
   * deleted from their picker. Presentation-only — hides the entry from the
   * business-type select; the search route still accepts curated values so
   * this carries no security weight. Managed by the same PUT
   * /api/sub-accounts/[id]/get-leads/types route. Absent = full curated list.
   */
  getLeadsHiddenTypes?: string[];
  /**
   * Agency-controlled gate for the Community + Courses feature (Skool-style
   * groups: feed + classroom + gamification, with magic-link members served at
   * the public `/c/[saId]/...` surface). Only the agency owner can flip it
   * (PATCH /api/agency/sub-accounts/[id]/feature-gates). When `false` (or
   * undefined on legacy docs): the Community sidebar entry renders a "Locked by
   * your agency" state AND every `/c/*` page + community API 404s/403s so a
   * disabled sub-account's groups are unreachable by direct URL. No tear-down on
   * disable — members, posts, and courses are preserved, so re-enabling resumes
   * instantly. Defaults to `false` at creation (explicit allowlist). Read
   * `=== true` so legacy docs stay locked. See "Community + Courses v1".
   */
  communityEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for Missed Call Text Back (MCTB). When `false` (or
   * undefined on legacy docs) the sub-account can't enable the feature — the
   * settings card shows a locked state and the config route 403s. When on, the
   * sub-account admin can point their dedicated Twilio number's Voice URL at our
   * handler, which forwards the call and auto-texts the caller on a miss. Ships
   * off (explicit allowlist). No tear-down beyond the sub-account's own
   * disable (which restores the number's prior Voice URL). Read `=== true`.
   */
  missedCallTextBackEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for the Labs section — the container for
   * PRE-RELEASE / experimental features (first resident: the Inbox
   * Follow-up Watchdog agent; see CUSTOM_AGENTS_V1_PLAN.md). Only the
   * agency owner can flip it (PATCH /api/agency/sub-accounts/[id]/
   * feature-gates). When `false` (or undefined on legacy docs): the Labs
   * sidebar entry renders "Locked by your agency" (or is hidden via
   * `labsHiddenWhenDisabled`) and the /labs page shows a locked card.
   * Defaults to `false` at creation (explicit opt-in — these features are
   * pre-release by definition). Individual experiments keep their own
   * runtime gates on top (e.g. the watchdog also requires
   * `aiSuiteEnabledByAgency` to spend AI credits). Read `=== true`.
   */
  labsEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for **Payments** (Payments v1) — the sub-account
   * connecting its OWN Stripe account so it can charge its OWN customers.
   * Opt-in: defaults to `false` at creation, consumers read `=== true`, so
   * legacy docs stay off. Gated by the agency because a connected key moves
   * real money and the agency is the one fielding "why did my client get
   * charged twice" — not because it spends agency resources (it spends none).
   * While off: the Settings → Payments card renders nothing and the
   * connection routes 403. No tear-down on disable — the stored connection is
   * preserved so re-enabling resumes instantly; a disconnect is always an
   * explicit operator action.
   *
   * NOT the same as Client Billing (`billing` on this doc), which is the
   * AGENCY charging THIS sub-account on the deployment's own Stripe.
   */
  paymentsEnabledByAgency?: boolean;
  /**
   * Non-secret display metadata for the connected Stripe account (see
   * {@link StripeConnectionMeta}). Null/absent until connected.
   *
   * The restricted key itself is deliberately NOT here — this doc is readable
   * by every active member, and Firestore rules can't hide a single field. The
   * secret lives at `subAccounts/{id}/private/stripeConnection`
   * (`allow read, write: if false`). Never add a credential to this object.
   */
  stripeConnectionMeta?: StripeConnectionMeta | null;
  /**
   * Non-secret display metadata for the connected Paystack account (see
   * {@link PaystackConnectionMeta}). The South African card rail — Stripe does
   * not serve SA merchants for payouts — and gated by the same
   * `paymentsEnabledByAgency` flag as the Stripe connection above.
   *
   * The secret key itself is deliberately NOT here, for the same
   * document-level-rules reason: it lives at
   * `subAccounts/{id}/private/paystackConnection`. Never add a credential to
   * this object.
   */
  paystackConnectionMeta?: PaystackConnectionMeta | null;
  /**
   * Webinar1 (webinar platform) connection — display metadata only. The API
   * key + webhook signing secret live at
   * `subAccounts/{id}/private/webinar1Connection` (locked; Admin SDK only),
   * for the same document-level-rules reason as the Stripe key above. Never
   * add a credential to this object. Null/absent = not connected.
   */
  webinar1ConnectionMeta?: Webinar1ConnectionMeta | null;
  /**
   * Agency-controlled gate for the Webinar1 integration (Webinars sidebar
   * entry + the Settings connection card + the /webinar1/* routes). Opt-in
   * like every other gate: defaults to `false` at creation and consumers read
   * `=== true` so legacy docs (undefined) stay off. Standalone (not
   * plan-managed) like Payments — an external platform connection is an
   * explicit per-client decision; promote into PLAN_GATE_KEYS if that
   * changes. Disabling 403s the routes and hides the UI; the stored
   * connection is preserved, so re-enabling resumes instantly.
   */
  webinar1EnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for the Google Business Profile connection
   * (Settings → Google Business Profile: the OAuth connect card and the
   * connect/disconnect routes). Opt-in like every other gate: defaults to
   * `false` at creation and consumers read `=== true` so legacy docs
   * (undefined) stay off. Standalone (not plan-managed) like Payments and
   * Webinar1 — connecting a client's Google account is an explicit per-client
   * decision. While off the settings card renders nothing and the connect
   * route refuses. No tear-down on disable: the stored connection is
   * preserved so re-enabling resumes instantly; disconnecting (which revokes
   * the token at Google) is always an explicit operator action and stays
   * available even while the gate is off.
   */
  googleEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for per-member Google Calendar sync (Settings →
   * Calendar sync → Google Calendar; see lib/google-calendar). Opt-in: `false`
   * at creation, read `=== true`. Standalone (not plan-managed) like the
   * Business Profile gate — linking staff Google accounts is an explicit
   * per-client decision. While off the card is hidden, connect refuses, and
   * booking pages neither read Google busy time nor push bookings. No
   * tear-down: members' connections are preserved; disconnect stays ungated.
   */
  googleCalendarEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for Reviews AI (SP5): AI sentiment on synced Google
   * reviews and AI reply drafts (SP5 c — they only fill the reply box). Spends the agency's OpenRouter
   * credits. Opt-in: `false` at creation, read `=== true`. Plan-managed
   * (`PLAN_GATE_KEYS`, not pre-ticked). No tear-down: cached sentiment labels
   * stay until the review's own lifecycle (edit, tombstone, retention)
   * clears them. See docs/features/reputation.md.
   */
  reviewsAiEnabledByAgency?: boolean;
  /**
   * Agency-controlled gate for the Agent API (v1) — an external LLM agent
   * holding an `agent`-scope key reading/managing this sub-account's CRM
   * over `POST /api/mcp` or `/api/v1/tools[/{name}]`. Layered ON TOP of
   * `apiAccessEnabledByAgency` (already checked by the public-API auth
   * middleware) — this gate additionally must be on. Defaults to `false`
   * at creation (explicit opt-in); read `=== true` so legacy docs stay
   * locked. No tear-down: an `agent`-scope key mint is simply refused
   * while off; existing keys are preserved so re-enabling resumes them.
   * Standalone gate, NOT in `PLAN_GATE_KEYS` — a plan never flips it.
   */
  agentApiEnabledByAgency?: boolean;
  /**
   * Reviews AI settings (SP5 c), written only by PUT
   * /api/sub-accounts/[id]/reputation/ai-settings (admin, Reviews AI gate).
   * `replyGuidelines` (≤ 1000 chars, "" = none) steer the reply DRAFT only —
   * nothing posts to Google without the admin's click.
   */
  reviewsAiConfig?: { replyGuidelines: string; updatedAt: Date; updatedByUid: string } | null;
  /**
   * Non-secret display metadata for the connected Google account (see
   * {@link GoogleConnectionMeta}). Null/absent until connected.
   *
   * The OAuth tokens are deliberately NOT here — this doc is readable by every
   * active member, and Firestore rules can't hide a single field. The refresh
   * token lives at `subAccounts/{id}/private/googleConnection`
   * (`allow read, write: if false`). Never add a credential to this object.
   */
  googleConnectionMeta?: GoogleConnectionMeta | null;
  /**
   * The Business Profile listing picked on the Google Business page (see
   * {@link GoogleListing}). Null/absent until selected; cleared on disconnect.
   */
  googleListing?: GoogleListing | null;
  /**
   * The public reviews widget for the selected listing (see
   * {@link GbpWidgetMeta}); null/absent when none. Written only by the server.
   */
  gbpWidgetMeta?: GbpWidgetMeta | null;
  /**
   * Agency-controlled gate for the Workspace Assistant (the in-app AI
   * assistant at Sidebar → Workspace Assistant). Only the agency owner can
   * flip it (PATCH /api/agency/sub-accounts/[id]/feature-gates). Opt-in like
   * every other gate: defaults to `false` at creation and consumers read
   * `=== true` so legacy docs (undefined) stay off. Gated because every
   * reply spends the agency's OpenRouter credits. While off, the sidebar
   * entry renders "Locked by your agency" and the chat/confirm/usage/thread
   * routes 403. No tear-down on disable — nothing is provisioned per
   * sub-account, so re-enabling resumes instantly. The agency-level
   * assistant has its own separate switch (`AgencyDoc.agencyAssistantEnabled`).
   */
  aiSuiteEnabledByAgency?: boolean;
  /**
   * Which model tier this sub-account's Workspace Assistant runs on (see
   * {@link AiSuiteModelChoice}). Agency-owner-controlled, set from the same
   * Manage dialog as the gate (PATCH .../feature-gates). Unset/legacy reads
   * as "sonnet". Only meaningful while `aiSuiteEnabledByAgency` is on.
   */
  aiSuiteModel?: AiSuiteModelChoice;
  /**
   * Per-feature "hide vs. show as Locked" control for the sidebar-gated features
   * (Broadcasts, Website, Social Planner, Community, Get Leads). They ONLY take
   * effect when the matching `*EnabledByAgency` gate is off. Default behavior
   * (field undefined / `true`) is HIDDEN: a disabled feature is omitted from the
   * sidebar entirely so the sub-account never knows it exists. Set explicitly to
   * `false` to instead render a greyed-out "Locked" sidebar entry (an upsell
   * hook). No effect while the feature is enabled. Only the agency owner can flip
   * these (same PATCH route as the gates). Read `!== false` so legacy/unset docs
   * default to hidden.
   */
  broadcastsHiddenWhenDisabled?: boolean;
  websiteHiddenWhenDisabled?: boolean;
  socialPlannerHiddenWhenDisabled?: boolean;
  communityHiddenWhenDisabled?: boolean;
  getLeadsHiddenWhenDisabled?: boolean;
  aiSuiteHiddenWhenDisabled?: boolean;
  labsHiddenWhenDisabled?: boolean;
  paymentsHiddenWhenDisabled?: boolean;
  webinar1HiddenWhenDisabled?: boolean;
  /**
   * BETA Facebook Messenger + Instagram DM connection. Null/undefined until the
   * sub-account admin connects a Page (only possible when
   * `metaInboxEnabledByAgency` is on). See {@link MetaConfig}.
   */
  metaConfig?: MetaConfig | null;
  /**
   * Which rail this sub-account's WhatsApp goes out on. Absent reads as
   * "twilio" — every workspace predating the provider seam is on Twilio, and
   * reading undefined as anything else would silently reroute a live rail.
   *
   * A cutover is this one field, so it is reversible in seconds. That matters
   * because moving a number between BSPs resets its WABA quality tier and
   * throttles it for weeks; an all-or-nothing switch would be untestable.
   * See docs/WHATSAPP_PROVIDER_PLAN.md.
   */
  whatsappProvider?: "twilio" | "cloud" | "bridge" | null;
  /**
   * Non-secret display half of the Meta Cloud connection. The credentials
   * themselves are in `private/whatsappCloudConnection` — this doc is
   * member-readable. See {@link WhatsappCloudMeta}.
   */
  whatsappCloudMeta?: WhatsappCloudMeta | null;
  /**
   * Non-secret display half of the wa-agent-bridge connection. The credentials
   * themselves are in `private/whatsappBridge` — this doc is member-readable.
   * See {@link WhatsappBridgeMeta}.
   */
  whatsappBridgeMeta?: WhatsappBridgeMeta | null;
  /**
   * The numbers this workspace can send WhatsApp FROM, so a workflow step can
   * choose one. Absent means the registry has never been touched: a single
   * sender is then synthesized from `whatsappProvider` and that rail's own
   * display metadata, so nothing about an existing workspace changes.
   * Display metadata only — credentials stay in `private/*`.
   * See {@link WhatsAppSender} and `lib/comms/whatsapp/resolve-sender.ts`.
   */
  whatsappSenders?: WhatsAppSender[] | null;
  bookingConfig: BookingConfig | null;
  sendWindow: SendWindow | null;
  /**
   * Generic booking-page URL surfaced via the {{bookingLink}} merge tag in
   * email + SMS templates. Calendly is the canonical case but any URL works
   * (Cal.com, TidyCal, SavvyCal, Stripe Payment Link, etc.). Null when the
   * sub-account hasn't set one — {{bookingLink}} resolves to empty string.
   */
  bookingLink: string | null;
  /**
   * Single source of truth for the Reply-To header on every email LeadStack
   * sends on behalf of this sub-account — automation lead-step emails AND
   * manual contact-profile sends. Null falls back to no Reply-To (current
   * default behavior). One address per sub-account by design — keeps
   * replies from one client landing consistently in one inbox regardless
   * of which teammate triggered the send.
   */
  replyToEmail: string | null;
  /**
   * Sub-account-level kill switch for the automation engine. When true:
   *   - fireTriggers() returns early without creating any execution docs
   *   - in-flight executions short-circuit at their next step with
   *     skippedReason: "automation_disabled"
   * Reset to false to resume firing. Defaults to false on creation; the
   * "Pause all workflows" toggle in Settings → Sending preferences drives it
   * (rehomed there after the legacy Automations pages were removed).
   */
  automationsPaused: boolean;
  /**
   * Primary point of contact at the client this sub-account belongs to —
   * the person the agency speaks to about this workspace. All fields
   * optional. Sub-accounts used for internal teams (not external clients)
   * can leave this null entirely. Surfaced on the sub-account dashboard
   * as a slim header strip and edited from Settings.
   */
  accountContact: AccountContact | null;
  /**
   * Per-sub-account PayPal connection used for the Products + Invoices
   * payment flow. v1 uses paypal.me links — sub-account owner pastes
   * their PayPal.me username; on invoice send we generate
   * `https://paypal.me/{username}/{amount}{currency}`. Null = not
   * connected. v2 will add Stripe Connect alongside.
   */
  paypalConfig: PayPalConfig | null;
  /**
   * Google review-request config (SMS / WhatsApp "leave us a review" sends
   * after payment or on demand). Optional — legacy/undefined reads as off.
   */
  googleReviewConfig?: GoogleReviewConfig | null;
  /**
   * Public https URL of this sub-account's brand logo. Renders on
   * quote/invoice emails, public /q/[token] pages, and PDFs — the
   * external surfaces this client's customers see. Distinct from
   * agency.logoUrl (which is internal CRM chrome). Null = no logo, the
   * sub-account name shows alone.
   */
  logoUrl: string | null;
  /**
   * Opt-in territory scoping. When true, collaborators only see deals
   * and contacts whose `territoryId` is in their `assignedTerritoryIds`.
   * Admins and the agency owner are unaffected. When false (the
   * default), territory data is preserved but ignored — the UI hides
   * every territory chip / column / picker, and rules short-circuit to
   * the existing per-sub-account access check. Strictly additive.
   * May be undefined on docs created before the feature shipped — read
   * `=== true` so the missing-field path stays off.
   */
  territoryScopingEnabled?: boolean;
  territoryScopingEnabledAt?: Date | null;
  territoryScopingEnabledByUid?: string | null;
  /**
   * LEGACY. Pre-multi-pipeline label/order overrides for the six canonical
   * stages. No longer written (the `pipeline-stages` route is gone); read
   * once to seed `subAccounts/{id}/pipelines/default` on its first load and
   * for the client's synthetic default until that read lands. After the
   * default pipeline doc exists this field is ignored.
   */
  pipelineStages?: import("./deals").PipelineStageOverride[];
  /**
   * GHL migration connection (Phase 4). Holds the location id used to pull
   * the account's data; the token itself is in `private/ghlImportCredentials`.
   * Null until connected; cleared on disconnect.
   */
  ghlImportConfig?: GhlImportConfig | null;
  /**
   * Client Billing v1 — the agency charges this sub-account through the
   * deployment's own Stripe account. Absent/null = "comped" (the default,
   * and every legacy doc): no charge, no paywall, gates stay manual. All
   * writes are server-side (billing service + Stripe webhook); members can
   * read it like the rest of the doc so the paywall/settings render without
   * extra requests. See {@link import("./billing").SubAccountBilling}.
   */
  billing?: import("./billing").SubAccountBilling | null;
}

export interface GhlImportConfig {
  /**
   * LEGACY — the GHL Private Integration Token now lives in the server-only
   * `private/ghlImportCredentials` doc; this field survives only on docs
   * written before that move. Never write it; read via
   * `readSubAccountSecret(id, "ghl", cfg)`.
   */
  token?: string;
  /** The GHL sub-account (location) id this token is scoped to. */
  locationId: string;
  connectedByUid: string | null;
  connectedAt: Timestamp | FieldValue | null;
  lastValidatedAt: Timestamp | FieldValue | null;
}

export interface AccountContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface TwilioConfig {
  /**
   * Master toggle for the dedicated-SMS feature on this sub-account. When
   * true, outbound + inbound SMS use the credentials below and the contact
   * profile renders the Messages tab + chat thread. When false (or this
   * whole config is null), the deployment falls back to the env-var
   * Twilio (existing shared-sender behavior). Strictly additive — flipping
   * this off restores the prior experience.
   */
  enabled: boolean;
  accountSid: string;
  /**
   * LEGACY — present only on docs written before the token moved to the
   * server-only `private/twilioCredentials` doc (this doc is member-readable).
   * Never write it; read the token via `readSubAccountSecret(id, "twilio", cfg)`.
   */
  authToken?: string;
  /**
   * Non-secret marker: true once the token is stored in
   * `private/twilioCredentials` (set by the save route and the migration), so
   * "is dedicated Twilio configured" stays answerable from this doc alone.
   */
  authTokenSet?: boolean;
  /** E.164 (e.g. "+15551234567"). The number this sub-account sends from. */
  fromNumber: string;
  /**
   * E.164 WhatsApp sender number for this sub-account (the number registered
   * to their Twilio WhatsApp sender / WABA), WITHOUT the `whatsapp:` prefix —
   * the Twilio wrapper adds it at send time. WhatsApp reuses the SMS creds
   * (`accountSid` + `authToken`) above; only the sending number differs.
   * Null/empty = WhatsApp not configured for this sub-account. In sandbox
   * mode this is Twilio's shared sandbox number.
   */
  whatsappFromNumber?: string | null;
  /**
   * True when `whatsappFromNumber` points at Twilio's shared WhatsApp
   * Sandbox (for testing before the WABA sender is approved) rather than a
   * production sender. Surfaced in the UI so operators know inbound only
   * works for numbers that have joined the sandbox via the join code.
   */
  whatsappSandbox?: boolean;
  /**
   * True once we've set the inbound webhook for the WhatsApp sender to point
   * at /api/webhooks/twilio/whatsapp/inbound. False/undefined if auto-config
   * failed or wasn't attempted (operator configures manually in Twilio).
   */
  whatsappInboundWebhookConfigured?: boolean;
  /**
   * True once we've called Twilio's IncomingPhoneNumbers API and set the
   * inbound smsUrl for `fromNumber` to point at our /api/webhooks/twilio/inbound
   * endpoint. False if auto-config failed (operator must configure manually).
   */
  inboundWebhookConfigured: boolean;
  /** Last time we successfully called Twilio's /Accounts/{sid} with the saved creds. */
  lastValidatedAt: Date | null;
  /**
   * Reserved for future use — a per-sub-account secret used to extra-verify
   * inbound webhooks beyond Twilio's signature. Null in v1; we rely on
   * Twilio's standard signature verification with `authToken`.
   */
  inboundWebhookSecret: string | null;
  /**
   * Missed Call Text Back (MCTB). Opt-in per sub-account (agency-gated via
   * `missedCallTextBackEnabledByAgency`). When enabled, this number's Twilio
   * Voice URL is pointed at /api/webhooks/twilio/voice, which forwards the
   * inbound call to `forwardTo` and — if it goes unanswered — auto-texts the
   * caller. Null/undefined = off (the number's Voice URL is left untouched).
   * Strictly additive; SMS is unaffected. Mutually exclusive with the AI
   * inbound Voice channel, which owns the Voice URL via Vapi — the config
   * route refuses to enable MCTB while that channel is on.
   */
  missedCall?: MissedCallConfig | null;
}

export interface MissedCallConfig {
  /** Master toggle. When true the number's Voice URL points at our handler. */
  enabled: boolean;
  /**
   * E.164 number the inbound call is forwarded to (the business's real phone /
   * cell). Required to enable — a forward-then-text flow needs somewhere to
   * ring first.
   */
  forwardTo: string;
  /** Seconds to ring `forwardTo` before treating the call as missed (5–60). */
  ringTimeoutSec: number;
  /**
   * SMS sent to the caller when the forward goes unanswered. Supports the same
   * {{merge}} tags as templates (resolved against the caller's contact).
   */
  messageBody: string;
  /**
   * The number's Voice URL captured BEFORE MCTB claimed it, so disabling
   * restores the operator's prior config instead of clobbering it. Null when
   * the number had no Voice URL set (the common case).
   */
  prevVoiceUrl: string | null;
  /** True once we successfully pointed the number's Voice URL at our endpoint. */
  voiceWebhookConfigured: boolean;
}

/**
 * BETA Meta (Facebook Messenger + Instagram DM) connection for one sub-account.
 * Null/undefined = not connected. Populated by the shared OAuth callback
 * (/api/meta/callback) after the sub-account admin connects a
 * Facebook Page; both Messenger and IG DM ride this single connection. Gated by
 * the agency `metaInboxEnabledByAgency` flag — nothing here is read or written
 * unless that gate is on. Strictly additive; absent on every existing doc.
 */
export interface MetaConfig {
  /** True once a Page has been connected + the webhook subscription attempted. */
  connected: boolean;
  /** Facebook Page id — the inbound webhook routes Messenger events by this. */
  pageId: string;
  /** Page display name, shown in the settings card. */
  pageName: string;
  /**
   * LEGACY — the long-lived Page access token now lives in the server-only
   * `private/metaCredentials` doc; this field survives only on docs written
   * before that move. Never write it; read via
   * `readSubAccountSecret(id, "meta", cfg)`.
   */
  pageAccessToken?: string;
  /** Linked Instagram business account id — inbound IG events route by this. Null if the Page has no IG account. */
  instagramBusinessAccountId: string | null;
  /** Linked IG @handle, shown in the settings card. Null when no IG account. */
  instagramUsername: string | null;
  /**
   * What the currently-stored Page token can actually do, derived from the
   * permissions Meta GRANTED at connect time (via /me/permissions) intersected
   * with the agency gates that were on. This is the single source of truth that
   * keeps the inbox and Social Planner from disagreeing about one shared
   * connection:
   *   - `inbox`   — true when the inbox gate is on AND `pages_messaging` was
   *                 granted (Messenger/IG DM send+receive).
   *   - `instagramDm` — true when the inbox gate is on AND
   *                 `instagram_manage_messages` was granted. Tracked
   *                 separately because a user can decline the IG scope while
   *                 granting `pages_messaging` — Messenger working never
   *                 implies IG DMs work.
   *   - `publish` — true when the Social gate is on AND `pages_manage_posts`
   *                 was granted (Social Planner posting).
   * Optional so legacy connections (made before capability tracking) read as
   * undefined; helpers treat missing `inbox` as true (back-compat — the inbox
   * worked), missing `instagramDm` as the `inbox` value (pre-field stamps),
   * and missing `publish` as false (must reconnect via the unified card to
   * gain posting). Reconnecting always refreshes this.
   */
  capabilities?: { inbox: boolean; publish: boolean; instagramDm?: boolean };
  connectedByUid: string | null;
  connectedAt: Timestamp | FieldValue | null;
}

export interface PayPalConfig {
  /**
   * PayPal.me username — the path segment after paypal.me/. 1-20 chars,
   * alphanumeric + hyphens. The operator finds this on
   * https://paypal.com/paypalme. Stored as the bare username (no
   * leading slash, no `paypal.me/` prefix).
   */
  username: string;
  connectedAt: Date;
}

/**
 * Per-sub-account Google review-request configuration. The dispatcher
 * (`lib/reviews/request.ts`) sends a "leave us a review" message after a
 * quote/invoice is marked paid (when `triggerOnQuotePaid`) or on demand via the
 * contact-profile button.
 */
export interface GoogleReviewConfig {
  /** Gates the AUTO trigger. The manual button works whenever `reviewUrl` is set. */
  enabled: boolean;
  /** Google review link, e.g. https://g.page/r/<id>/review. */
  reviewUrl: string;
  /**
   * "sms" | "whatsapp_template" (approved template) | "whatsapp_manual"
   * (free-form WhatsApp, in-window only). Legacy docs may store "whatsapp" —
   * normalize via `normalizeReviewChannel`.
   */
  channel: "sms" | "whatsapp_template" | "whatsapp_manual";
  /** Free-form body (SMS + whatsapp_manual). Tags: {{firstName}} / {{businessName}} / {{reviewUrl}}. */
  messageTemplate: string;
  /** Id of an APPROVED whatsappTemplates doc — only for `whatsapp_template`. */
  whatsappTemplateId: string | null;
  /** Skip an AUTO re-ask if the contact was asked within this many days. */
  cooldownDays: number;
  triggerOnQuotePaid: boolean;
  /**
   * Auto-send when a Won deal is ticked "Completed" on the pipeline card.
   * Like `triggerOnQuotePaid`, only meaningful for SMS / WhatsApp Template
   * (WhatsApp Manual can't auto-send). Undefined on legacy docs → off.
   */
  triggerOnDealCompleted?: boolean;
  /**
   * Reminders (SP5 d2): re-send the same request every `everyDays` until the
   * customer clicks, opts out, or `maxRetries` reminders have gone. Absent or
   * `everyDays: null` = off (the default) — nothing about sending changes.
   */
  reminder?: { everyDays: number | null; maxRetries: number } | null;
  updatedAt: Date;
}

export interface ResendConfig {
  /** Resend Domains-API UUID for this sub-account's dedicated sending domain. */
  domainId: string;
  /** The verified (sub)domain emails send from, e.g. "mail.acmeplumbing.com". */
  domainName: string;
  /** Full From header built on `domainName`, e.g. "Acme Plumbing <hello@mail.acmeplumbing.com>". */
  emailFrom: string;
  /**
   * Verification state from Resend. Only "verified" gates live sending; any
   * other value (or a null `resendConfig`) falls back to the shared EMAIL_FROM.
   */
  status: "pending" | "verified" | "failed";
  /** Last time we successfully polled Resend and confirmed the domain status. */
  lastValidatedAt: Date | null;
}

export interface BookingConfig {
  defaultPageSlug: string;
  types: Array<{ slug: string; label: string; durationMinutes: number }>;
}

export interface SendWindow {
  startHour: number;
  endHour: number;
  timezone: string;
}

export interface AgencyMemberDoc {
  uid: string;
  agencyId: string;
  role: AgencyRole;
  status: MemberStatus;
  email: string;
  displayName: string;
  addedAt: Date;
  addedByUid: string;
}

/**
 * The display slice of a member row that GET /api/sub-accounts/[id]/members
 * returns to every active member for the "Assigned to" pickers.
 */
export interface AssignableMember {
  uid: string;
  /** Display name, or the email when none is set, or the uid. */
  displayName: string;
  /** Empty unless the member has no display name (then it IS the label). */
  email: string;
  role: string;
}

export interface SubAccountMemberDoc {
  uid: string;
  subAccountId: string;
  agencyId: string;
  role: SubAccountRole;
  status: MemberStatus;
  email: string;
  displayName: string;
  addedAt: Date;
  addedByUid: string;
  /**
   * Territory ids this member can see deals/contacts for. Empty array
   * (or undefined on legacy rows) = no territory access. Ignored when
   * the member is admin OR the sub-account's `territoryScopingEnabled`
   * is not true.
   */
  assignedTerritoryIds?: string[];
}

export type TerritoryStatus = "active" | "archived";

/**
 * Reserved id for the auto-seeded "Global" territory every sub-account
 * gets when territory scoping is first enabled. Contacts and members
 * default to Global, so flipping scoping on doesn't blank anyone's
 * pipeline — admins then carve out real territories and move reps off
 * Global. Fixed id (not an auto-id) so every default path can reference
 * it without a lookup. Per-sub-account (lives at
 * subAccounts/{saId}/territories/global).
 */
export const GLOBAL_TERRITORY_ID = "global";

/**
 * Sub-account-scoped territory / region / state used by the opt-in
 * territory-scoping feature. Lives at
 *   subAccounts/{saId}/territories/{territoryId}
 * Admin-managed via /api/sub-accounts/[id]/territories/*.
 */
export interface TerritoryDoc {
  id: string;
  subAccountId: string;
  agencyId: string;
  /** Display name, 1–60 chars, unique per sub-account (case-insensitive). */
  name: string;
  /** Optional short code, 1–12 chars (e.g. "CA", "DACH"). */
  code: string | null;
  status: TerritoryStatus;
  createdByUid: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface InviteDocV2 {
  id: string;
  email: string;
  agencyId: string;
  subAccountId: string | null;
  subAccountRole: SubAccountRole | null;
  agencyRole: AgencyRole | null;
  invitedByUid: string;
  createdAt: Date;
  acceptedByUid: string | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  /**
   * Territories to pre-assign when this collaborator accepts. Applied to
   * their `subAccountMembers/{uid}.assignedTerritoryIds` at signup. Empty
   * / absent → the new member defaults to Global. Only meaningful for
   * `subAccountRole === "collaborator"` while territory scoping is on;
   * ignored for admin invites (admins always see every territory).
   */
  assignedTerritoryIds?: string[];
  /**
   * SHA-256 of the single-use token in the invite link. Signup must present
   * the matching token; rotated on every re-send. Absent on invites created
   * before tokens existed — those must be re-sent to be claimable.
   */
  tokenHash?: string;
}

export interface UserSubAccountMembership {
  subAccountId: string;
  agencyId: string;
  role: SubAccountRole;
  name: string;
  /**
   * Mirror of SubAccountDoc.accountNumber. May be undefined for sub-accounts
   * created before the numbering migration; UI should fall back gracefully.
   */
  accountNumber?: number;
  addedAt: Date;
}

export interface UserAgencyMembership {
  agencyId: string;
  role: AgencyRole;
  name: string;
}

export interface TenantScope {
  agencyId: string;
  subAccountId: string;
}
