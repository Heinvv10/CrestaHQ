import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  requireAgencyOwner,
  requireSubAccountAdmin,
} from "@/lib/auth/require-tenancy";
import {
  findDedicatedNumberHolder,
  invalidateSubAccountTwilioCache,
} from "@/lib/comms/twilio";
import {
  autoConfigureInboundWebhook,
  validateCredentials,
} from "@/lib/comms/twilio-config";
import type { TwilioConfig } from "@/types";
import {
  readSubAccountSecret,
  subAccountSecretDoc,
  subAccountSecretPath,
} from "@/lib/server/sub-account-secrets";

/**
 * Manage the per-sub-account Twilio config.
 *
 * POST  — create or update the dedicated config. Body:
 *   { accountSid, authToken, fromNumber }
 *
 *   Flow:
 *     1. requireSubAccountAdmin
 *     2. refuse if another sub-account already claims fromNumber — the
 *        inbound webhook routes by number with limit(1), so a duplicate
 *        claim silently hijacks the first claimant's inbound traffic
 *     3. validateCredentials() — round-trip Twilio /Accounts/{sid}
 *     4. autoConfigureInboundWebhook() — best-effort PATCH the number's smsUrl.
 *        Failure here is reported in the response but doesn't block the save —
 *        the operator can configure the webhook URL manually from the settings
 *        page.
 *     5. Persist twilioConfig with enabled: true.
 *     6. Invalidate the in-memory client cache so subsequent sends pick up
 *        the new creds without a server restart.
 *
 * DELETE — turn off the dedicated config (sets enabled: false but keeps the
 *   creds — SID on the doc, token in private/twilioCredentials — so toggling
 *   back on is a one-click affair). The
 *   inbound webhook on the Twilio side is left alone — gracefully degrades:
 *   if the operator re-enables, the webhook URL is still pointed at us.
 */

interface PostBody {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
}

function inboundWebhookUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  return `${base}/api/webhooks/twilio/inbound`;
}

function normalisePhone(s: string): string {
  let cleaned = s.trim().replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("00")) cleaned = "+" + cleaned.slice(2);
  return cleaned;
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

  const accountSid = body.accountSid?.trim() ?? "";
  const fromNumberRaw = body.fromNumber?.trim() ?? "";
  const fromNumber = fromNumberRaw ? normalisePhone(fromNumberRaw) : "";

  // "Leave blank to keep" — the auth token is write-only (never sent back to
  // the browser), so an empty field on an existing config means "reuse the
  // token I saved before". Load the existing config and fall back to its
  // stored token when the operator left the field blank.
  const existingSnap = await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .get();
  const existingCfg =
    (existingSnap.data() as { twilioConfig?: TwilioConfig } | undefined)
      ?.twilioConfig ?? null;

  const submittedToken = body.authToken?.trim() ?? "";
  const authToken =
    submittedToken ||
    (existingCfg ? await readSubAccountSecret(subAccountId, "twilio", existingCfg) : "");

  if (!accountSid || !fromNumber) {
    return NextResponse.json(
      { error: "accountSid and fromNumber are both required." },
      { status: 400 },
    );
  }
  if (!authToken) {
    return NextResponse.json(
      {
        error:
          "Auth token is required. Paste it from your Twilio console — there's no saved token to reuse yet.",
      },
      { status: 400 },
    );
  }
  if (!fromNumber.startsWith("+")) {
    return NextResponse.json(
      { error: "fromNumber must be E.164 (e.g. +15551234567)." },
      { status: 400 },
    );
  }
  if (!accountSid.startsWith("AC")) {
    return NextResponse.json(
      { error: "accountSid should start with AC (Twilio Account SID format)." },
      { status: 400 },
    );
  }

  // Step 1: refuse if another sub-account already holds this number. The
  // inbound webhook resolves the sub-account by fromNumber with limit(1),
  // so letting a second claim through would silently hijack (or, with the
  // wrong auth token, 403-break) the first claimant's inbound traffic.
  const holder = await findDedicatedNumberHolder({
    field: "fromNumber",
    number: fromNumber,
    excludeSubAccountId: subAccountId,
  });
  if (holder) {
    return NextResponse.json(
      {
        error: `${fromNumber} is already the dedicated SMS number for "${holder}". Saving would silently take over its inbound routing — use a different number, or disable the Twilio config on that sub-account first.`,
      },
      { status: 409 },
    );
  }

  // Step 2: validate the creds against Twilio.
  const validation = await validateCredentials(accountSid, authToken);
  if (!validation.ok) {
    return NextResponse.json(
      { error: `Twilio rejected the credentials: ${validation.error ?? "unknown"}` },
      { status: 400 },
    );
  }

  // Step 3: best-effort auto-config of the inbound webhook.
  const webhookUrl = inboundWebhookUrl();
  let webhookResult = { ok: false, error: null as string | null };
  if (webhookUrl) {
    webhookResult = await autoConfigureInboundWebhook({
      accountSid,
      authToken,
      fromNumber,
      webhookUrl,
    });
  } else {
    webhookResult.error =
      "NEXT_PUBLIC_APP_URL is not set on this deployment — webhook URL must be configured manually.";
  }

  // Step 4: persist. The token goes to the server-only private doc; the
  // member-readable sub-account doc keeps only non-secret status, and any
  // pre-migration copy of the token on it is deleted in the same batch.
  const cfg: TwilioConfig = {
    enabled: true,
    accountSid,
    fromNumber,
    authTokenSet: true,
    inboundWebhookConfigured: webhookResult.ok,
    lastValidatedAt: new Date(),
    inboundWebhookSecret: null,
  };
  const db = getAdminDb();
  const batch = db.batch();
  batch.set(
    db.doc(subAccountSecretPath(subAccountId, "twilio")),
    subAccountSecretDoc("twilio", authToken),
  );
  batch.set(
    db.doc(`subAccounts/${subAccountId}`),
    {
      twilioConfig: { ...cfg, authToken: FieldValue.delete() },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await batch.commit();

  invalidateSubAccountTwilioCache(subAccountId);

  return NextResponse.json({
    ok: true,
    friendlyName: validation.friendlyName,
    inboundWebhookConfigured: webhookResult.ok,
    inboundWebhookUrl: webhookUrl,
    inboundWebhookError: webhookResult.error,
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  // Agency-owner only, unlike POST. Split by who bears the cost: saving
  // your own creds (POST) spends your own Twilio balance, so sub-account
  // admins may. Falling back to the shared sender spends the AGENCY's
  // balance AND makes inbound replies unroutable (the webhook resolves the
  // sub-account by dedicated number — on the shared number replies reach
  // nobody), so only the owner may flip it.
  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const agencyId = (subSnap.data()?.agencyId as string) ?? "";
  const access = await requireAgencyOwner(request, agencyId);
  if (access instanceof NextResponse) return access;

  // Disable the dedicated config but keep the creds (token stays in the
  // private doc) — toggling
  // back on is a one-click affair from the settings UI. Use update() so the
  // dot-notation key is a nested field path; set({merge:true}) would take
  // "twilioConfig.enabled" literally and never flip the real nested field.
  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .update({
      "twilioConfig.enabled": false,
      updatedAt: FieldValue.serverTimestamp(),
    });

  invalidateSubAccountTwilioCache(subAccountId);
  return NextResponse.json({ ok: true });
}
