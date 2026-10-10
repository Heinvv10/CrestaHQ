import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { buildTwilioClient } from "@/lib/comms/twilio";
import {
  dialerGateOn,
  dialerGateRefusal,
  dialerPrivateRef,
  dialerTwilioCreds,
  dialerTwimlUrl,
  errText,
  getDialerPrivate,
} from "@/lib/comms/dialer";
import type { SubAccountDoc } from "@/types";

/**
 * Softphone v1 — provision / configure / tear down the browser dialer.
 *
 * POST   — enable. Requires the sub-account's dedicated Twilio
 *          (`twilioConfig.enabled` + accountSid + auth token + fromNumber).
 *          Creates a Twilio API Key + a TwiML App (voice URL → our dialer
 *          TwiML webhook) on THAT account; secrets land in
 *          `subAccounts/{id}/private/dialer`, the client-visible
 *          `dialerConfig` flags on the doc. Re-enabling with an existing
 *          provision just refreshes the TwiML App's voice URL (so a changed
 *          NEXT_PUBLIC_APP_URL heals on re-save) and re-flips enabled — it
 *          never mints a second key or app.
 * PATCH  — body { recordCalls: boolean } — toggles call recording.
 * DELETE — best-effort removes the TwiML App + API Key from Twilio, deletes
 *          the private doc, clears dialerConfig.
 *
 * All admin-gated. POST and PATCH also need the agency gate
 * `dialerEnabledByAgency` (403 `gate_off`); DELETE stays ungated so a
 * sub-account can always tear down what it provisioned after the gate is
 * switched off. The Twilio auth token is read from `private/twilioCredentials`
 * via `readSubAccountSecret`, never from the member-readable parent doc.
 *
 * PATCH does not look at the dedicated-Twilio state: it places no call and
 * reaches no Twilio API, and the flag it writes is only read by the TwiML
 * webhook, which refuses while dedicated Twilio is off.
 */

async function loadSub(subAccountId: string) {
  const subRef = getAdminDb().doc(`subAccounts/${subAccountId}`);
  const sub = ((await subRef.get()).data() ?? {}) as Partial<SubAccountDoc>;
  return { subRef, sub };
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const { subRef, sub } = await loadSub(subAccountId);
  if (!dialerGateOn(sub)) return dialerGateRefusal();

  if (!process.env.NEXT_PUBLIC_APP_URL) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL is not configured on this deployment." },
      { status: 503 },
    );
  }

  const creds = await dialerTwilioCreds(subAccountId, sub);
  if (!creds) {
    return NextResponse.json(
      {
        error:
          "Set up your dedicated Twilio number first (Settings → SMS). The dialer calls through your own Twilio account.",
      },
      { status: 400 },
    );
  }

  const client = buildTwilioClient(creds.accountSid, creds.authToken);
  const voiceUrl = dialerTwimlUrl(subAccountId);

  try {
    const existing = await getDialerPrivate(subAccountId);
    if (existing) {
      // Refresh the voice URL (heals a moved deployment) and re-enable.
      await client.applications(existing.twimlAppSid).update({
        voiceUrl,
        voiceMethod: "POST",
      });
    } else {
      const app = await client.applications.create({
        friendlyName: `LeadStack dialer sa:${subAccountId}`,
        voiceUrl,
        voiceMethod: "POST",
      });
      const key = await client.newKeys.create({
        friendlyName: `LeadStack dialer sa:${subAccountId}`,
      });
      await dialerPrivateRef(subAccountId).set({
        apiKeySid: key.sid,
        apiKeySecret: key.secret,
        twimlAppSid: app.sid,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    // The message only — never the error object (see errText).
    const message =
      err instanceof Error ? err.message : "Twilio provisioning failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  await subRef.set(
    {
      dialerConfig: {
        enabled: true,
        recordCalls: sub.dialerConfig?.recordCalls === true,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return NextResponse.json({ ok: true });
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { recordCalls?: boolean };
  try {
    body = (await request.json()) as { recordCalls?: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.recordCalls !== "boolean") {
    return NextResponse.json(
      { error: "recordCalls (boolean) is required" },
      { status: 400 },
    );
  }

  const { subRef, sub } = await loadSub(subAccountId);
  if (!dialerGateOn(sub)) return dialerGateRefusal();
  if (sub.dialerConfig?.enabled !== true) {
    return NextResponse.json(
      { error: "Enable the dialer first." },
      { status: 400 },
    );
  }

  await subRef.set(
    {
      dialerConfig: { enabled: true, recordCalls: body.recordCalls },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const { subRef, sub } = await loadSub(subAccountId);
  const priv = await getDialerPrivate(subAccountId);

  // Best-effort Twilio teardown — a failed remote delete never blocks disable.
  // Without working dedicated creds the remote key + app cannot be reached and
  // are left on the client's Twilio account (logged).
  const creds = priv ? await dialerTwilioCreds(subAccountId, sub) : null;
  if (priv && creds) {
    const client = buildTwilioClient(creds.accountSid, creds.authToken);
    await client
      .applications(priv.twimlAppSid)
      .remove()
      .catch((err: unknown) => {
        console.warn("[dialer] TwiML App remove failed", subAccountId, errText(err));
      });
    await client
      .keys(priv.apiKeySid)
      .remove()
      .catch((err: unknown) => {
        console.warn("[dialer] API key remove failed", subAccountId, errText(err));
      });
  } else if (priv) {
    console.warn(
      "[dialer] disable without dedicated Twilio creds — remote key/app left in place",
      subAccountId,
    );
  }
  await dialerPrivateRef(subAccountId)
    .delete()
    .catch((err: unknown) => {
      console.warn("[dialer] private doc delete failed", subAccountId, errText(err));
    });

  await subRef.set(
    { dialerConfig: null, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return NextResponse.json({ ok: true });
}
