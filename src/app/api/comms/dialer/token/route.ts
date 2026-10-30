import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  dialerEnabled,
  dialerGateOn,
  dialerGateRefusal,
  dialerTwilioReady,
  getDialerPrivate,
  mintDialerToken,
} from "@/lib/comms/dialer";
import type { SubAccountDoc } from "@/types";

/**
 * Softphone v1 — mint a short-TTL Twilio Voice AccessToken for the browser
 * Device. Any active member of the sub-account (or its agency owner) can call
 * — same trust level as sending an SMS from a contact. The browser only ever
 * sees this scoped JWT — the API key secret stays in the Admin-SDK-only
 * private doc. Refused with 403 `gate_off` while `dialerEnabledByAgency` is off,
 * and with 403 while the dialer or dedicated Twilio is switched off.
 */
export async function POST(request: Request) {
  let body: { subAccountId?: string };
  try {
    body = (await request.json()) as { subAccountId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const subAccountId = body.subAccountId?.trim();
  if (!subAccountId) {
    return NextResponse.json(
      { error: "subAccountId is required" },
      { status: 400 },
    );
  }

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const sub = (
    await getAdminDb().doc(`subAccounts/${subAccountId}`).get()
  ).data() as SubAccountDoc | undefined;

  if (!dialerGateOn(sub)) return dialerGateRefusal();
  if (!dialerEnabled(sub)) {
    return NextResponse.json(
      { error: "The dialer isn't enabled for this workspace." },
      { status: 403 },
    );
  }
  if (!dialerTwilioReady(sub)) {
    return NextResponse.json(
      { error: "Dedicated Twilio is switched off for this workspace, so the dialer can't place calls." },
      { status: 403 },
    );
  }
  const accountSid = sub?.twilioConfig?.accountSid;
  const priv = await getDialerPrivate(subAccountId);
  if (!accountSid || !priv) {
    return NextResponse.json(
      { error: "The dialer isn't fully provisioned — re-enable it in Settings." },
      { status: 503 },
    );
  }

  const token = mintDialerToken({
    accountSid,
    apiKeySid: priv.apiKeySid,
    apiKeySecret: priv.apiKeySecret,
    twimlAppSid: priv.twimlAppSid,
    identity: access.uid,
  });

  return NextResponse.json({ ok: true, token, ttlSeconds: 3600 });
}
