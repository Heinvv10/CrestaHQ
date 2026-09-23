import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { loadEffectiveTerritoryScope } from "@/lib/auth/territory-filter";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import { voiceAudienceQuery } from "@/lib/comms/voice/audience";
import { issueVoiceCampaignCode } from "@/lib/comms/voice/campaign-number";
import { getChannelConfig } from "@/lib/comms/ai/agent";
import { vapiIsConfigured } from "@/lib/comms/voice/vapi";
import type {
  BroadcastAudienceFilter,
  SubAccountDoc,
  VoiceCampaignDoc,
  VoiceCampaignSuppression,
} from "@/types";

export const dynamic = "force-dynamic";

interface SendBody {
  subAccountId?: string;
  audienceFilter?: BroadcastAudienceFilter;
  consentAck?: boolean;
  /** Optional operator label for the campaign. */
  name?: string;
  /** Optional cross-campaign suppression. */
  suppression?: Partial<VoiceCampaignSuppression>;
}

/** Hard cap on per-campaign audience size. */
const MAX_AUDIENCE_SIZE = 25_000;

/**
 * Kick off a bulk outbound AI voice campaign. Sizes the audience, creates
 * the campaign doc, and hands off to /api/comms/voice/campaign/fanout, which
 * pages through the audience creating recipient rows and publishing one
 * delayed message per recipient. Each callback (/api/comms/voice/campaign/
 * step) runs the per-call compliance gate and places (or skips / defers)
 * one call. Staggered at the sub-account's configured per-minute cap so the
 * burst limiter never trips and calls are paced.
 */
export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured — bulk calling needs the queue." },
      { status: 503 },
    );
  }
  if (!vapiIsConfigured()) {
    return NextResponse.json(
      { error: "Voice calling isn't configured on this deployment." },
      { status: 503 },
    );
  }

  let payload: SendBody;
  try {
    payload = (await request.json()) as SendBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subAccountId = payload.subAccountId?.trim();
  const audienceFilter = payload.audienceFilter;
  if (!subAccountId || !audienceFilter) {
    return NextResponse.json(
      { error: "subAccountId and audienceFilter are required" },
      { status: 400 },
    );
  }
  if (
    audienceFilter.kind !== "all" &&
    audienceFilter.kind !== "tag" &&
    audienceFilter.kind !== "pipeline_stage"
  ) {
    return NextResponse.json(
      { error: "audienceFilter.kind must be 'all', 'tag', or 'pipeline_stage'" },
      { status: 400 },
    );
  }
  if (payload.consentAck !== true) {
    return NextResponse.json(
      { error: "consentAck is required to start a calling campaign." },
      { status: 400 },
    );
  }

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();

  // Agency gate.
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const subAccount = subSnap.data() as SubAccountDoc;
  if (subAccount.outboundVoiceEnabledByAgency !== true) {
    return NextResponse.json(
      {
        error:
          "Outbound calling is disabled for this sub-account. Your agency administrator can enable it from Manage.",
      },
      { status: 403 },
    );
  }

  // Voice channel + provisioning prerequisites.
  const channel = await getChannelConfig(subAccountId, "voice");
  const voice = channel?.voice ?? null;
  if (!voice || voice.outboundEnabled !== true) {
    return NextResponse.json(
      { error: "Outbound calling isn't enabled in the Voice settings." },
      { status: 403 },
    );
  }
  if (!voice.vapiAssistantId || !voice.vapiPhoneNumberId) {
    return NextResponse.json(
      { error: "Enable the Voice channel first so the calling number is provisioned." },
      { status: 400 },
    );
  }

  // Normalise suppression settings (clamp + null-out empties) for audit
  // storage and the resolver.
  const rawSup = payload.suppression ?? {};
  const recentDaysRaw =
    typeof rawSup.recentDays === "number" && rawSup.recentDays > 0
      ? Math.min(365, Math.floor(rawSup.recentDays))
      : null;
  const suppression: VoiceCampaignSuppression = {
    recentDays: recentDaysRaw,
    excludeCampaignId:
      typeof rawSup.excludeCampaignId === "string" && rawSup.excludeCampaignId.trim()
        ? rawSup.excludeCampaignId.trim()
        : null,
    excludeTag:
      typeof rawSup.excludeTag === "string" && rawSup.excludeTag.trim()
        ? rawSup.excludeTag.trim()
        : null,
  };

  // Size the audience with an aggregate count — the contacts themselves are
  // read page by page in the fanout step, never whole inside this request.
  // The count is pre-skip (opted-out / no-phone / suppressed included), so
  // the cap errs on the side of refusing.
  const matching = (
    await voiceAudienceQuery(subAccountId, audienceFilter).count().get()
  ).data().count;
  if (matching === 0) {
    return NextResponse.json(
      { error: "Audience is empty — no contacts match this filter." },
      { status: 400 },
    );
  }
  if (matching > MAX_AUDIENCE_SIZE) {
    return NextResponse.json(
      {
        error: `Audience size ${matching} exceeds the cap of ${MAX_AUDIENCE_SIZE}. Narrow the filter.`,
      },
      { status: 400 },
    );
  }

  // The caller's territory scope, carried to the fanout step in the
  // (signed) QStash body.
  const scope = await loadEffectiveTerritoryScope(access);
  const territoryIds = scope.enforce ? (scope.ids ?? []) : null;

  // Trigger-user display name snapshot.
  let createdByName = access.email;
  try {
    const u = await getAdminAuth().getUser(access.uid);
    createdByName = u.displayName || u.email || access.email;
  } catch {
    /* fall through */
  }

  const agencyId = subAccount.agencyId;
  const campaignRef = db.collection("voiceCampaigns").doc();
  const code = await issueVoiceCampaignCode(subAccountId);

  const campaign: Omit<VoiceCampaignDoc, "id"> = {
    agencyId,
    subAccountId,
    code,
    name:
      typeof payload.name === "string" ? payload.name.trim().slice(0, 120) : "",
    suppression,
    audienceFilter,
    openerPreview: voice.outboundFirstMessage.slice(0, 200),
    status: "queued",
    // Filled in page by page by the fanout step.
    totals: {
      audienceSize: 0,
      queued: 0,
      called: 0,
      skipped: 0,
      failed: 0,
      interested: 0,
    },
    consentAck: true,
    createdByUid: access.uid,
    createdBy: { displayName: createdByName, email: access.email },
    createdAt: FieldValue.serverTimestamp() as unknown as null,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    fanoutDone: false,
  };
  await campaignRef.set({ id: campaignRef.id, ...campaign });

  // Hand the audience to the fanout step, which pages through it and
  // publishes the paced per-recipient steps — stagger at the per-minute cap
  // so calls are paced and the burst limiter never trips.
  const perMinute = Math.max(1, voice.outboundPerMinuteCap);
  const fanout = await publishCallback({
    pathname: "/api/comms/voice/campaign/fanout",
    body: {
      campaignId: campaignRef.id,
      cursor: null,
      slot: 0,
      spacingSec: 60 / perMinute,
      territoryIds,
    },
    delaySeconds: 0,
    deduplicationId: `vcampfan_${campaignRef.id}_start`,
  });
  if (!fanout) {
    await campaignRef.update({
      status: "failed",
      errorMessage: "Could not schedule the campaign. Check QStash and NEXT_PUBLIC_APP_URL.",
      completedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json(
      { error: "Failed to schedule the campaign. Check QStash configuration." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    campaignId: campaignRef.id,
    audienceSize: matching,
  });
}
