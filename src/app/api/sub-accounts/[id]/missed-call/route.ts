import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { subAccountTwilioIsConfigured } from "@/lib/comms/twilio";
import {
  configureVoiceWebhook,
  restoreVoiceWebhook,
} from "@/lib/comms/twilio-config";
import {
  DEFAULT_MCTB_MESSAGE,
  DEFAULT_MCTB_RING_TIMEOUT_SEC,
} from "@/lib/comms/missed-call";
import type { MissedCallConfig, SubAccountDoc } from "@/types";

/**
 * Missed Call Text Back config for one sub-account.
 *
 * POST   — enable / update. Body: { forwardTo, ringTimeoutSec?, messageBody? }.
 *          Preconditions (all 403/400): agency gate on, dedicated Twilio
 *          enabled, AND the AI inbound Voice channel OFF (it owns the Voice
 *          URL via Vapi — MCTB and AI Voice are mutually exclusive on a
 *          number). On success we point the number's Voice URL at our handler
 *          (capturing the prior URL so disable can restore it) and persist the
 *          config.
 * DELETE  — disable. Restores the number's prior Voice URL (best-effort) and
 *          flips `missedCall.enabled` off, keeping the rest of the config so a
 *          re-enable is one click.
 */

interface PostBody {
  forwardTo?: string;
  ringTimeoutSec?: number;
  messageBody?: string;
}

function voiceWebhookUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  return `${base}/api/webhooks/twilio/voice`;
}

function normalisePhone(s: string): string {
  let cleaned = s.trim().replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("00")) cleaned = "+" + cleaned.slice(2);
  return cleaned;
}

async function aiVoiceEnabled(subAccountId: string): Promise<boolean> {
  try {
    const snap = await getAdminDb()
      .doc(`subAccounts/${subAccountId}/aiAgent/voice`)
      .get();
    return snap.exists && (snap.data()?.enabled as boolean | undefined) === true;
  } catch {
    return false;
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const sa = snap.data() as SubAccountDoc;
  const cfg = sa.twilioConfig ?? null;

  // Precondition 1: agency gate.
  if (sa.missedCallTextBackEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Missed Call Text Back is disabled by your agency." },
      { status: 403 },
    );
  }
  // Precondition 2: dedicated Twilio (we need the number + creds).
  if (!subAccountTwilioIsConfigured(cfg) || !cfg) {
    return NextResponse.json(
      {
        error:
          "Enable a dedicated Twilio number for this sub-account first (Settings → SMS).",
      },
      { status: 400 },
    );
  }
  // Precondition 3: AI inbound Voice must be OFF — a Twilio number has ONE
  // Voice URL, and the AI Voice channel hands it to Vapi. Don't fight over it.
  if (await aiVoiceEnabled(subAccountId)) {
    return NextResponse.json(
      {
        error:
          "AI inbound Voice is enabled on this number — it already answers calls. Turn off AI Voice (AI Agents → Voice) before enabling Missed Call Text Back.",
      },
      { status: 409 },
    );
  }

  const forwardTo = normalisePhone(body.forwardTo ?? "");
  if (!forwardTo.startsWith("+")) {
    return NextResponse.json(
      { error: "forwardTo must be E.164 (e.g. +15551234567)." },
      { status: 400 },
    );
  }
  const ringTimeoutSec = Math.min(
    60,
    Math.max(5, Math.round(body.ringTimeoutSec || DEFAULT_MCTB_RING_TIMEOUT_SEC)),
  );
  const messageBody = (body.messageBody ?? "").trim() || DEFAULT_MCTB_MESSAGE;

  // Point the number's Voice URL at our handler (best-effort), capturing the
  // prior URL so disable restores it. Keep any previously-captured prevVoiceUrl
  // so re-enabling twice doesn't overwrite the original with our own URL.
  const webhookUrl = voiceWebhookUrl();
  let voiceWebhookConfigured = false;
  let webhookError: string | null = null;
  let prevVoiceUrl = cfg.missedCall?.prevVoiceUrl ?? null;
  if (!webhookUrl) {
    webhookError =
      "NEXT_PUBLIC_APP_URL is not set on this deployment — configure the number's Voice URL manually.";
  } else {
    const result = await configureVoiceWebhook({
      accountSid: cfg.accountSid,
      authToken: cfg.authToken,
      fromNumber: cfg.fromNumber,
      webhookUrl,
    });
    voiceWebhookConfigured = result.ok;
    webhookError = result.error;
    // Only adopt a freshly-read prior URL when we didn't already have one AND
    // Twilio didn't hand us back our own endpoint (guards double-enable).
    if (
      prevVoiceUrl === null &&
      result.prevVoiceUrl &&
      result.prevVoiceUrl !== webhookUrl
    ) {
      prevVoiceUrl = result.prevVoiceUrl;
    }
  }

  const missedCall: MissedCallConfig = {
    enabled: true,
    forwardTo,
    ringTimeoutSec,
    messageBody,
    prevVoiceUrl,
    voiceWebhookConfigured,
  };
  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .update({
      "twilioConfig.missedCall": missedCall,
      updatedAt: FieldValue.serverTimestamp(),
    });

  return NextResponse.json({
    ok: true,
    voiceWebhookConfigured,
    voiceWebhookUrl: webhookUrl,
    voiceWebhookError: webhookError,
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sa = snap.data() as SubAccountDoc | undefined;
  const cfg = sa?.twilioConfig ?? null;

  // Best-effort restore of the number's prior Voice URL.
  if (cfg?.accountSid && cfg.authToken && cfg.fromNumber) {
    await restoreVoiceWebhook({
      accountSid: cfg.accountSid,
      authToken: cfg.authToken,
      fromNumber: cfg.fromNumber,
      prevVoiceUrl: cfg.missedCall?.prevVoiceUrl ?? null,
    });
  }

  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .update({
      "twilioConfig.missedCall.enabled": false,
      "twilioConfig.missedCall.voiceWebhookConfigured": false,
      updatedAt: FieldValue.serverTimestamp(),
    });

  return NextResponse.json({ ok: true });
}
