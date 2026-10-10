import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import twilio from "twilio";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireContactAccessible } from "@/lib/comms/route-auth";
import {
  dialerActivityId,
  dialerAuthToken,
  dialerEnabled,
  dialerGateOn,
  dialerGateRefusal,
  dialerStatusUrl,
  uidFromClientAddress,
  validateDialerSignature,
} from "@/lib/comms/dialer";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Softphone v1 — the TwiML App voice URL. Twilio POSTs here when the browser
 * Device places a call (`device.connect({ params: { contactId } })`); our
 * response tells Twilio who to dial and how.
 *
 * Security: X-Twilio-Signature validated with the SUB-ACCOUNT's auth token,
 * read from `private/twilioCredentials` via `readSubAccountSecret` (the TwiML
 * App lives on their account, so their token signs the request). The
 * sub-account comes from the URL path; the dial target is resolved
 * SERVER-side from the contact doc — any `To` the browser sends is ignored.
 *
 * Guards before any dial: agency gate `dialerEnabledByAgency` (403 — Twilio
 * plays its application-error message), dialerConfig.enabled re-check, the
 * caller (`From: client:<uid>`, the identity we minted into the token) can
 * still act on the contact (active member or agency owner, territory scope —
 * `requireContactAccessible`, as on every other comms route), the contact
 * belongs to this sub-account and has a phone, and `contact.voiceOptedOut`
 * (spoken rejection + hangup — the call never leaves Twilio).
 *
 * Side-effect: writes the `call_placed` activity row (deterministic id
 * `dialer_<CallSid>`) so the call shows on the timeline immediately; the
 * <Dial action> callback updates it with the outcome + duration + recording.
 */

function twiml(res: InstanceType<typeof twilio.twiml.VoiceResponse>) {
  return new NextResponse(res.toString(), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

function rejection(message: string) {
  const res = new twilio.twiml.VoiceResponse();
  res.say(message);
  res.hangup();
  return twiml(res);
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> },
) {
  const { subAccountId } = await ctx.params;

  const raw = await request.text();
  const params = Object.fromEntries(new URLSearchParams(raw).entries());

  const db = getAdminDb();
  const sub = (
    await db.doc(`subAccounts/${subAccountId}`).get()
  ).data() as SubAccountDoc | undefined;

  const authToken = await dialerAuthToken(subAccountId, sub);
  if (!authToken) {
    return new NextResponse("Unknown sub-account", { status: 404 });
  }
  if (!validateDialerSignature({ request, authToken, params })) {
    return new NextResponse("Invalid signature", { status: 403 });
  }

  if (!dialerGateOn(sub)) return dialerGateRefusal();
  if (!dialerEnabled(sub)) {
    return rejection("The dialer is disabled for this workspace. Goodbye.");
  }
  const fromNumber = sub?.twilioConfig?.fromNumber;
  if (!fromNumber) {
    return rejection("No caller I D number is configured. Goodbye.");
  }

  const contactId = (params["contactId"] ?? "").trim();
  if (!contactId) {
    return rejection("No contact was specified for this call. Goodbye.");
  }
  const uid = uidFromClientAddress(params["From"]);
  if (!uid) {
    return rejection("This call did not come from the dialer. Goodbye.");
  }
  const contact = await requireContactAccessible(uid, contactId);
  if (contact instanceof NextResponse || contact.subAccountId !== subAccountId) {
    return rejection("That contact could not be found. Goodbye.");
  }
  if (!contact.phone) {
    return rejection("That contact has no phone number. Goodbye.");
  }
  if (contact.voiceOptedOut === true) {
    return rejection(
      "This contact has opted out of phone calls, so the call cannot be placed. Goodbye.",
    );
  }

  // Timeline row up-front — the operator sees the call the moment it dials.
  const callSid = params["CallSid"] ?? "";
  if (callSid) {
    try {
      await db
        .collection("contacts")
        .doc(contactId)
        .collection("activities")
        .doc(dialerActivityId(callSid))
        .set({
          type: "call_placed",
          content: "Phone call — in progress",
          createdBy: uid,
          meta: { callSid, status: "in-progress" },
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn("[dialer/twiml] activity write failed", err);
    }
  }

  const res = new twilio.twiml.VoiceResponse();
  const dial = res.dial({
    callerId: fromNumber,
    answerOnBridge: true,
    action: dialerStatusUrl(subAccountId, contactId),
    method: "POST",
    ...(sub?.dialerConfig?.recordCalls === true
      ? { record: "record-from-answer-dual" as const }
      : {}),
  });
  dial.number(contact.phone);
  return twiml(res);
}
