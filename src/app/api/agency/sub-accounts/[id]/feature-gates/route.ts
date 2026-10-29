import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { activeOwnerRefusal } from "@/lib/auth/require-active-agency-owner";
import { metaAppConfigured } from "@/lib/comms/meta";
import { recordSubAccountAuditEvent } from "@/lib/audit/record";
import {
  sanitizeUsageQuotas,
  sanitizeUsageRates,
} from "@/lib/server/usage-meter";
import {
  applyFeatureGates,
  recordGateChanges,
  type AgencyGateField,
} from "@/lib/server/feature-gates-service";

/**
 * Agency-only feature gates per sub-account. Each gate is a boolean toggle
 * the agency owner controls. The payload is shaped as an object so
 * gates can be set independently (only the fields you send get applied)
 * or together in one round-trip from the Manage dialog.
 *
 * Today's gates:
 *   - `emailDomainEnabled` — dedicated Resend sending domain. Disabling
 *     tears down the verified domain (frees the Resend slot) and clears
 *     `resendConfig` so sends fall back to EMAIL_FROM immediately.
 *   - `apiAccessEnabled` — the public API (v1). Disabling 403s every
 *     `/api/v1/*` request and blocks new key / webhook mints, but
 *     PRESERVES existing keys + subscriptions so re-enabling resumes
 *     them instantly (no painful re-rotation of Zapier integrations).
 *   - `metaInboxEnabled` — BETA master switch for the Facebook Messenger +
 *     Instagram DM inbox channels. Pure toggle today (no consumer slices
 *     yet) so the feature stays inert + invisible while off.
 *
 * Auth: agency owner only (requireSubAccountMember + role check). Sub-account
 * admins can NOT flip their own gates — the whole point is that the agency
 * controls what its tenants can do.
 */

interface PatchBody {
  emailDomainEnabled?: boolean;
  apiAccessEnabled?: boolean;
  broadcastsEnabled?: boolean;
  outboundVoiceEnabled?: boolean;
  whatsappEnabled?: boolean;
  smsAgentEnabled?: boolean;
  webChatEnabled?: boolean;
  inboundVoiceEnabled?: boolean;
  metaInboxEnabled?: boolean;
  metaAgentEnabled?: boolean;
  websiteEnabled?: boolean;
  socialPlannerEnabled?: boolean;
  communityEnabled?: boolean;
  missedCallTextBackEnabled?: boolean;
  aiSuiteEnabled?: boolean;
  /**
   * Model tier for this sub-account's Workspace Assistant. Not a gate — a
   * plain owner-set preference stored alongside the gate ("opus" | "sonnet";
   * unset reads as opus). See SubAccountDoc.aiSuiteModel.
   */
  aiSuiteModel?: "opus" | "sonnet";
  labsEnabled?: boolean;
  getLeadsEnabled?: boolean;
  prospectingEnabled?: boolean;
  /**
   * Monthly prospect-report quota (integer 0–1000). Not a gate: writes
   * directly like the hide flags. Anything else is refused with a 400.
   */
  prospectingReportQuota?: number;
  /** First-touch prospect sends a day (integer 0–1000), written like the quota. */
  prospectingDailyFirstTouchCap?: number;
  /** Mystery shops a month (integer 0–1000), written like the quota. */
  prospectingMysteryShopCap?: number;
  paymentsEnabled?: boolean;
  webinar1Enabled?: boolean;
  googleEnabled?: boolean;
  googleCalendarEnabled?: boolean;
  webVoiceEnabled?: boolean;
  dialerEnabled?: boolean;
  emailAiDraftsEnabled?: boolean;
  reviewsAiEnabled?: boolean;
  reviewsAutoReplyEnabled?: boolean;
  agentApiEnabled?: boolean;
  /**
   * Usage Metering v1 — per-workspace quota override. Not a gate: writes
   * directly like the hide flags. `null` clears back to plan/unlimited;
   * an object sanitizes to positive integers per unit.
   */
  usageQuotas?: import("@/types/usage").UsageQuotas | null;
  /** v1.5 — per-workspace overage-rate override; same contract as quotas. */
  usageRates?: import("@/types/usage").UsageRates | null;
  /**
   * Usage rebilling for this client. Not a gate (never plan-managed);
   * switching it on is refused unless the agency's master switch is on.
   */
  usageRebillingEnabled?: boolean;
  // "Hide instead of lock" overrides for the sidebar-gated features.
  // Only take effect while the matching gate is off. See `*HiddenWhenDisabled`
  // on SubAccountDoc.
  broadcastsHiddenWhenDisabled?: boolean;
  websiteHiddenWhenDisabled?: boolean;
  socialPlannerHiddenWhenDisabled?: boolean;
  communityHiddenWhenDisabled?: boolean;
  getLeadsHiddenWhenDisabled?: boolean;
  prospectingHiddenWhenDisabled?: boolean;
  aiSuiteHiddenWhenDisabled?: boolean;
  labsHiddenWhenDisabled?: boolean;
  paymentsHiddenWhenDisabled?: boolean;
  webinar1HiddenWhenDisabled?: boolean;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (access.subAccountRole !== "agencyOwner") {
    return NextResponse.json({ error: "Agency owner only" }, { status: 403 });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    body.usageRebillingEnabled !== undefined &&
    typeof body.usageRebillingEnabled !== "boolean"
  ) {
    return NextResponse.json(
      { error: "usageRebillingEnabled must be a boolean." },
      { status: 400 }
    );
  }

  // Switching a reach gate on widens what an agency key reaches, so the
  // owner claim alone is not enough: it outlives a removal.
  // Rebilling a client is a money switch, held to the same live-row check.
  if (
    body.apiAccessEnabled === true ||
    body.agentApiEnabled === true ||
    body.usageRebillingEnabled === true
  ) {
    const refusal = await activeOwnerRefusal(access.uid, access.agencyId!);
    if (refusal) return refusal;
  }

  const wantsEmail = typeof body.emailDomainEnabled === "boolean";
  const wantsApi = typeof body.apiAccessEnabled === "boolean";
  const wantsBroadcasts = typeof body.broadcastsEnabled === "boolean";
  const wantsOutboundVoice = typeof body.outboundVoiceEnabled === "boolean";
  const wantsWhatsapp = typeof body.whatsappEnabled === "boolean";
  const wantsSmsAgent = typeof body.smsAgentEnabled === "boolean";
  const wantsWebChat = typeof body.webChatEnabled === "boolean";
  const wantsInboundVoice = typeof body.inboundVoiceEnabled === "boolean";
  const wantsMetaInbox = typeof body.metaInboxEnabled === "boolean";
  const wantsMetaAgent = typeof body.metaAgentEnabled === "boolean";
  const wantsWebsite = typeof body.websiteEnabled === "boolean";
  const wantsSocialPlanner = typeof body.socialPlannerEnabled === "boolean";
  const wantsCommunity = typeof body.communityEnabled === "boolean";
  const wantsMissedCall = typeof body.missedCallTextBackEnabled === "boolean";
  const wantsAiSuite = typeof body.aiSuiteEnabled === "boolean";
  const wantsAiSuiteModel = body.aiSuiteModel !== undefined;
  if (
    wantsAiSuiteModel &&
    body.aiSuiteModel !== "opus" &&
    body.aiSuiteModel !== "sonnet"
  ) {
    return NextResponse.json(
      { error: "aiSuiteModel must be 'opus' or 'sonnet'." },
      { status: 400 }
    );
  }
  const wantsLabs = typeof body.labsEnabled === "boolean";
  const wantsGetLeads = typeof body.getLeadsEnabled === "boolean";
  const wantsProspecting = typeof body.prospectingEnabled === "boolean";
  const wantsProspectingQuota = body.prospectingReportQuota !== undefined;
  if (
    wantsProspectingQuota &&
    !(
      Number.isInteger(body.prospectingReportQuota) &&
      (body.prospectingReportQuota as number) >= 0 &&
      (body.prospectingReportQuota as number) <= 1000
    )
  ) {
    return NextResponse.json(
      { error: "prospectingReportQuota must be a whole number from 0 to 1000." },
      { status: 400 }
    );
  }
  const wantsFirstTouchCap = body.prospectingDailyFirstTouchCap !== undefined;
  if (
    wantsFirstTouchCap &&
    !(
      Number.isInteger(body.prospectingDailyFirstTouchCap) &&
      (body.prospectingDailyFirstTouchCap as number) >= 0 &&
      (body.prospectingDailyFirstTouchCap as number) <= 1000
    )
  ) {
    return NextResponse.json(
      { error: "prospectingDailyFirstTouchCap must be a whole number from 0 to 1000." },
      { status: 400 }
    );
  }
  const wantsMysteryShopCap = body.prospectingMysteryShopCap !== undefined;
  if (
    wantsMysteryShopCap &&
    !(
      Number.isInteger(body.prospectingMysteryShopCap) &&
      (body.prospectingMysteryShopCap as number) >= 0 &&
      (body.prospectingMysteryShopCap as number) <= 1000
    )
  ) {
    return NextResponse.json(
      { error: "prospectingMysteryShopCap must be a whole number from 0 to 1000." },
      { status: 400 }
    );
  }
  const wantsPayments = typeof body.paymentsEnabled === "boolean";
  const wantsWebinar1 = typeof body.webinar1Enabled === "boolean";
  const wantsGoogle = typeof body.googleEnabled === "boolean";
  const wantsGoogleCalendar = typeof body.googleCalendarEnabled === "boolean";
  const wantsWebVoice = typeof body.webVoiceEnabled === "boolean";
  const wantsDialer = typeof body.dialerEnabled === "boolean";
  const wantsEmailAiDrafts = typeof body.emailAiDraftsEnabled === "boolean";
  const wantsReviewsAi = typeof body.reviewsAiEnabled === "boolean";
  const wantsReviewsAutoReply =
    typeof body.reviewsAutoReplyEnabled === "boolean";
  const wantsAgentApi = typeof body.agentApiEnabled === "boolean";
  const wantsBroadcastsHidden =
    typeof body.broadcastsHiddenWhenDisabled === "boolean";
  const wantsWebsiteHidden =
    typeof body.websiteHiddenWhenDisabled === "boolean";
  const wantsSocialPlannerHidden =
    typeof body.socialPlannerHiddenWhenDisabled === "boolean";
  const wantsCommunityHidden =
    typeof body.communityHiddenWhenDisabled === "boolean";
  const wantsGetLeadsHidden =
    typeof body.getLeadsHiddenWhenDisabled === "boolean";
  const wantsProspectingHidden =
    typeof body.prospectingHiddenWhenDisabled === "boolean";
  const wantsAiSuiteHidden =
    typeof body.aiSuiteHiddenWhenDisabled === "boolean";
  const wantsLabsHidden = typeof body.labsHiddenWhenDisabled === "boolean";
  const wantsPaymentsHidden =
    typeof body.paymentsHiddenWhenDisabled === "boolean";
  const wantsWebinar1Hidden =
    typeof body.webinar1HiddenWhenDisabled === "boolean";
  // Usage Metering v1 — per-workspace quota override. `null` clears back
  // to plan/unlimited; an object sanitizes to valid positive integers.
  const wantsUsageQuotas = body.usageQuotas !== undefined;
  const wantsUsageRates = body.usageRates !== undefined;
  const wantsRebilling = typeof body.usageRebillingEnabled === "boolean";
  if (
    !wantsRebilling &&
    !wantsUsageQuotas &&
    !wantsUsageRates &&
    !wantsEmail &&
    !wantsApi &&
    !wantsBroadcasts &&
    !wantsOutboundVoice &&
    !wantsWhatsapp &&
    !wantsSmsAgent &&
    !wantsWebChat &&
    !wantsInboundVoice &&
    !wantsMetaInbox &&
    !wantsMetaAgent &&
    !wantsWebsite &&
    !wantsSocialPlanner &&
    !wantsCommunity &&
    !wantsMissedCall &&
    !wantsAiSuite &&
    !wantsAiSuiteModel &&
    !wantsLabs &&
    !wantsGetLeads &&
    !wantsProspecting &&
    !wantsProspectingQuota &&
    !wantsFirstTouchCap &&
    !wantsMysteryShopCap &&
    !wantsPayments &&
    !wantsWebinar1 &&
    !wantsGoogle &&
    !wantsGoogleCalendar &&
    !wantsWebVoice &&
    !wantsDialer &&
    !wantsEmailAiDrafts &&
    !wantsReviewsAi &&
    !wantsReviewsAutoReply &&
    !wantsAgentApi &&
    !wantsBroadcastsHidden &&
    !wantsWebsiteHidden &&
    !wantsSocialPlannerHidden &&
    !wantsCommunityHidden &&
    !wantsGetLeadsHidden &&
    !wantsProspectingHidden &&
    !wantsAiSuiteHidden &&
    !wantsLabsHidden &&
    !wantsPaymentsHidden &&
    !wantsWebinar1Hidden
  ) {
    return NextResponse.json(
      {
        error:
          "At least one of `emailDomainEnabled`, `apiAccessEnabled`, `broadcastsEnabled`, `outboundVoiceEnabled`, `whatsappEnabled`, `metaInboxEnabled`, `websiteEnabled`, `socialPlannerEnabled`, `broadcastsHiddenWhenDisabled`, `websiteHiddenWhenDisabled`, or `socialPlannerHiddenWhenDisabled` (boolean) is required.",
      },
      { status: 400 }
    );
  }

  // Meta features need app creds on the deployment. Refuse to ENABLE either
  // Meta gate when unconfigured (the UI grays these out; this guards the API).
  // Disabling is always allowed.
  if (
    (body.metaInboxEnabled === true ||
      body.socialPlannerEnabled === true ||
      body.metaAgentEnabled === true) &&
    !metaAppConfigured()
  ) {
    return NextResponse.json(
      {
        error:
          "Facebook/Instagram isn't configured on this deployment. Set META_APP_ID and META_APP_SECRET to enable the inbox or Social Planner.",
      },
      { status: 400 }
    );
  }

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const subSnap = await subRef.get();
  if (!subSnap.exists) {
    return NextResponse.json(
      { error: "Sub-account not found" },
      { status: 404 }
    );
  }
  const storedRebilling = subSnap.data()?.usageRebillingEnabled === true;

  // Checked before any write, so a refusal leaves every other field alone.
  if (body.usageRebillingEnabled === true) {
    const agencySnap = await db.doc(`agencies/${subSnap.data()?.agencyId}`).get();
    if (agencySnap.data()?.usageRebillingEnabled !== true) {
      return NextResponse.json(
        {
          error:
            "Turn on Usage rebilling for the agency first (Agency → Client billing).",
        },
        { status: 400 }
      );
    }
  }

  // Gate fields — routed through the shared chokepoint
  // (lib/server/feature-gates-service.ts) so per-gate side effects (the
  // email-domain tear-down, the Meta configured guard) can never drift
  // from the plan-driven application path in Client Billing.
  const gates: Partial<Record<AgencyGateField, boolean>> = {};
  if (typeof body.emailDomainEnabled === "boolean") {
    gates.emailDomainEnabledByAgency = body.emailDomainEnabled;
  }
  if (typeof body.apiAccessEnabled === "boolean") {
    gates.apiAccessEnabledByAgency = body.apiAccessEnabled;
  }
  if (typeof body.broadcastsEnabled === "boolean") {
    gates.broadcastsEnabledByAgency = body.broadcastsEnabled;
  }
  if (typeof body.outboundVoiceEnabled === "boolean") {
    gates.outboundVoiceEnabledByAgency = body.outboundVoiceEnabled;
  }
  if (typeof body.whatsappEnabled === "boolean") {
    gates.whatsappEnabledByAgency = body.whatsappEnabled;
  }
  if (typeof body.smsAgentEnabled === "boolean") {
    gates.smsAgentEnabledByAgency = body.smsAgentEnabled;
  }
  if (typeof body.webChatEnabled === "boolean") {
    gates.webChatEnabledByAgency = body.webChatEnabled;
  }
  if (typeof body.inboundVoiceEnabled === "boolean") {
    gates.inboundVoiceEnabledByAgency = body.inboundVoiceEnabled;
  }
  if (typeof body.metaInboxEnabled === "boolean") {
    gates.metaInboxEnabledByAgency = body.metaInboxEnabled;
  }
  if (typeof body.metaAgentEnabled === "boolean") {
    gates.metaAgentEnabledByAgency = body.metaAgentEnabled;
  }
  if (typeof body.websiteEnabled === "boolean") {
    gates.websiteEnabledByAgency = body.websiteEnabled;
  }
  if (typeof body.socialPlannerEnabled === "boolean") {
    gates.socialPlannerEnabledByAgency = body.socialPlannerEnabled;
  }
  if (typeof body.communityEnabled === "boolean") {
    gates.communityEnabledByAgency = body.communityEnabled;
  }
  if (typeof body.missedCallTextBackEnabled === "boolean") {
    gates.missedCallTextBackEnabledByAgency = body.missedCallTextBackEnabled;
  }
  if (typeof body.aiSuiteEnabled === "boolean") {
    gates.aiSuiteEnabledByAgency = body.aiSuiteEnabled;
  }
  if (typeof body.labsEnabled === "boolean") {
    gates.labsEnabledByAgency = body.labsEnabled;
  }
  if (typeof body.getLeadsEnabled === "boolean") {
    gates.getLeadsEnabledByAgency = body.getLeadsEnabled;
  }
  if (typeof body.prospectingEnabled === "boolean") {
    gates.prospectingEnabledByAgency = body.prospectingEnabled;
  }
  if (typeof body.paymentsEnabled === "boolean") {
    gates.paymentsEnabledByAgency = body.paymentsEnabled;
  }
  if (typeof body.webinar1Enabled === "boolean") {
    gates.webinar1EnabledByAgency = body.webinar1Enabled;
  }
  if (typeof body.googleEnabled === "boolean") {
    gates.googleEnabledByAgency = body.googleEnabled;
  }
  if (typeof body.googleCalendarEnabled === "boolean") {
    gates.googleCalendarEnabledByAgency = body.googleCalendarEnabled;
  }
  if (typeof body.webVoiceEnabled === "boolean") {
    gates.webVoiceEnabledByAgency = body.webVoiceEnabled;
  }
  if (typeof body.dialerEnabled === "boolean") {
    gates.dialerEnabledByAgency = body.dialerEnabled;
  }
  if (typeof body.emailAiDraftsEnabled === "boolean") {
    gates.emailAiDraftsEnabledByAgency = body.emailAiDraftsEnabled;
  }
  if (typeof body.reviewsAiEnabled === "boolean") {
    gates.reviewsAiEnabledByAgency = body.reviewsAiEnabled;
  }
  if (typeof body.agentApiEnabled === "boolean") {
    gates.agentApiEnabledByAgency = body.agentApiEnabled;
  }
  if (typeof body.reviewsAutoReplyEnabled === "boolean") {
    gates.reviewsAutoReplyEnabledByAgency = body.reviewsAutoReplyEnabled;
  }

  let clearedDomain = false;
  if (Object.keys(gates).length > 0) {
    ({ clearedDomain } = await applyFeatureGates(subAccountId, gates));
    await recordGateChanges(subAccountId, access.uid, subSnap.data() ?? {}, gates);
  }

  // "Hide instead of lock" overrides. Pure presentation flags — they don't
  // change any runtime enforcement (a disabled feature's routes 403 the same
  // way regardless); they only decide whether the sidebar shows a greyed
  // "Locked" entry or omits it entirely. Persisted independently of the gate
  // so the agency owner can pre-set "hide" before flipping the feature off.
  // Not plan-managed, so they update here rather than in the gate service.
  const hiddenUpdates: Record<string, unknown> = {};
  // Workspace Assistant model tier — a preference, not a gate, so it writes
  // directly here (never plan-managed) alongside the hide flags.
  if (wantsAiSuiteModel) {
    hiddenUpdates.aiSuiteModel = body.aiSuiteModel;
  }
  if (wantsBroadcastsHidden) {
    hiddenUpdates.broadcastsHiddenWhenDisabled =
      body.broadcastsHiddenWhenDisabled;
  }
  if (wantsWebsiteHidden) {
    hiddenUpdates.websiteHiddenWhenDisabled = body.websiteHiddenWhenDisabled;
  }
  if (wantsSocialPlannerHidden) {
    hiddenUpdates.socialPlannerHiddenWhenDisabled =
      body.socialPlannerHiddenWhenDisabled;
  }
  if (wantsCommunityHidden) {
    hiddenUpdates.communityHiddenWhenDisabled =
      body.communityHiddenWhenDisabled;
  }
  if (wantsGetLeadsHidden) {
    hiddenUpdates.getLeadsHiddenWhenDisabled = body.getLeadsHiddenWhenDisabled;
  }
  if (wantsProspectingHidden) {
    hiddenUpdates.prospectingHiddenWhenDisabled =
      body.prospectingHiddenWhenDisabled;
  }
  if (wantsProspectingQuota) {
    hiddenUpdates.prospectingReportQuota = body.prospectingReportQuota;
  }
  if (wantsFirstTouchCap) {
    hiddenUpdates.prospectingDailyFirstTouchCap =
      body.prospectingDailyFirstTouchCap;
  }
  if (wantsMysteryShopCap) {
    hiddenUpdates.prospectingMysteryShopCap = body.prospectingMysteryShopCap;
  }
  if (wantsAiSuiteHidden) {
    hiddenUpdates.aiSuiteHiddenWhenDisabled = body.aiSuiteHiddenWhenDisabled;
  }
  if (wantsLabsHidden) {
    hiddenUpdates.labsHiddenWhenDisabled = body.labsHiddenWhenDisabled;
  }
  if (wantsPaymentsHidden) {
    hiddenUpdates.paymentsHiddenWhenDisabled = body.paymentsHiddenWhenDisabled;
  }
  if (wantsWebinar1Hidden) {
    hiddenUpdates.webinar1HiddenWhenDisabled = body.webinar1HiddenWhenDisabled;
  }
  if (wantsUsageQuotas) {
    hiddenUpdates.usageQuotas = sanitizeUsageQuotas(body.usageQuotas);
  }
  if (wantsUsageRates) {
    hiddenUpdates.usageRates = sanitizeUsageRates(body.usageRates);
  }
  if (wantsRebilling) {
    hiddenUpdates.usageRebillingEnabled = body.usageRebillingEnabled;
    if (body.usageRebillingEnabled === true && !storedRebilling) {
      hiddenUpdates.usageRebillingSince = FieldValue.serverTimestamp();
    }
  }
  if (Object.keys(hiddenUpdates).length > 0) {
    hiddenUpdates.updatedAt = FieldValue.serverTimestamp();
    await subRef.update(hiddenUpdates);
  }
  if (wantsRebilling && body.usageRebillingEnabled !== storedRebilling) {
    await recordSubAccountAuditEvent(db, subAccountId, {
      action: "usage_rebilling.updated",
      actor: { type: "user", id: access.uid },
      target: { type: "subAccount", id: subAccountId },
      changes: [
        {
          field: "usageRebillingEnabled",
          before: storedRebilling,
          after: body.usageRebillingEnabled,
        },
      ],
    });
  }

  return NextResponse.json({
    ok: true,
    ...(wantsEmail ? { emailDomainEnabled: body.emailDomainEnabled } : {}),
    ...(wantsApi ? { apiAccessEnabled: body.apiAccessEnabled } : {}),
    ...(wantsBroadcasts ? { broadcastsEnabled: body.broadcastsEnabled } : {}),
    ...(wantsOutboundVoice
      ? { outboundVoiceEnabled: body.outboundVoiceEnabled }
      : {}),
    ...(wantsWhatsapp ? { whatsappEnabled: body.whatsappEnabled } : {}),
    ...(wantsSmsAgent ? { smsAgentEnabled: body.smsAgentEnabled } : {}),
    ...(wantsWebChat ? { webChatEnabled: body.webChatEnabled } : {}),
    ...(wantsInboundVoice
      ? { inboundVoiceEnabled: body.inboundVoiceEnabled }
      : {}),
    ...(wantsMetaInbox ? { metaInboxEnabled: body.metaInboxEnabled } : {}),
    ...(wantsMetaAgent ? { metaAgentEnabled: body.metaAgentEnabled } : {}),
    ...(wantsWebsite ? { websiteEnabled: body.websiteEnabled } : {}),
    ...(wantsSocialPlanner
      ? { socialPlannerEnabled: body.socialPlannerEnabled }
      : {}),
    ...(wantsCommunity ? { communityEnabled: body.communityEnabled } : {}),
    ...(wantsMissedCall
      ? { missedCallTextBackEnabled: body.missedCallTextBackEnabled }
      : {}),
    ...(wantsAiSuite ? { aiSuiteEnabled: body.aiSuiteEnabled } : {}),
    ...(wantsAiSuiteModel ? { aiSuiteModel: body.aiSuiteModel } : {}),
    ...(wantsLabs ? { labsEnabled: body.labsEnabled } : {}),
    ...(wantsGetLeads ? { getLeadsEnabled: body.getLeadsEnabled } : {}),
    ...(wantsProspecting
      ? { prospectingEnabled: body.prospectingEnabled }
      : {}),
    ...(wantsProspectingQuota
      ? { prospectingReportQuota: body.prospectingReportQuota }
      : {}),
    ...(wantsFirstTouchCap
      ? { prospectingDailyFirstTouchCap: body.prospectingDailyFirstTouchCap }
      : {}),
    ...(wantsMysteryShopCap
      ? { prospectingMysteryShopCap: body.prospectingMysteryShopCap }
      : {}),
    ...(wantsWebinar1 ? { webinar1Enabled: body.webinar1Enabled } : {}),
    ...(wantsGoogle ? { googleEnabled: body.googleEnabled } : {}),
    ...(wantsGoogleCalendar
      ? { googleCalendarEnabled: body.googleCalendarEnabled }
      : {}),
    ...(wantsWebVoice ? { webVoiceEnabled: body.webVoiceEnabled } : {}),
    ...(wantsDialer ? { dialerEnabled: body.dialerEnabled } : {}),
    ...(wantsEmailAiDrafts
      ? { emailAiDraftsEnabled: body.emailAiDraftsEnabled }
      : {}),
    ...(wantsReviewsAi ? { reviewsAiEnabled: body.reviewsAiEnabled } : {}),
    ...(wantsReviewsAutoReply
      ? { reviewsAutoReplyEnabled: body.reviewsAutoReplyEnabled }
      : {}),
    ...(wantsAgentApi ? { agentApiEnabled: body.agentApiEnabled } : {}),
    ...(wantsRebilling
      ? { usageRebillingEnabled: body.usageRebillingEnabled }
      : {}),
    ...(wantsWebinar1Hidden
      ? { webinar1HiddenWhenDisabled: body.webinar1HiddenWhenDisabled }
      : {}),
    ...(wantsBroadcastsHidden
      ? { broadcastsHiddenWhenDisabled: body.broadcastsHiddenWhenDisabled }
      : {}),
    ...(wantsWebsiteHidden
      ? { websiteHiddenWhenDisabled: body.websiteHiddenWhenDisabled }
      : {}),
    ...(wantsSocialPlannerHidden
      ? {
          socialPlannerHiddenWhenDisabled: body.socialPlannerHiddenWhenDisabled,
        }
      : {}),
    ...(wantsCommunityHidden
      ? { communityHiddenWhenDisabled: body.communityHiddenWhenDisabled }
      : {}),
    ...(wantsGetLeadsHidden
      ? { getLeadsHiddenWhenDisabled: body.getLeadsHiddenWhenDisabled }
      : {}),
    ...(wantsProspectingHidden
      ? { prospectingHiddenWhenDisabled: body.prospectingHiddenWhenDisabled }
      : {}),
    ...(wantsAiSuiteHidden
      ? { aiSuiteHiddenWhenDisabled: body.aiSuiteHiddenWhenDisabled }
      : {}),
    ...(wantsLabsHidden
      ? { labsHiddenWhenDisabled: body.labsHiddenWhenDisabled }
      : {}),
    ...(clearedDomain ? { clearedDomain: true } : {}),
  });
}
