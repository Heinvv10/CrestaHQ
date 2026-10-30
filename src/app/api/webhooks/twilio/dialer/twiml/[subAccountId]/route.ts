import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import twilio from "twilio";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireContactAccessible } from "@/lib/comms/route-auth";
import { getChannelConfig } from "@/lib/comms/ai/agent";
import { storedInInternationalForm } from "@/lib/comms/dialer-shared";
import { isDocId } from "@/lib/server/doc-id";
import {
  countryBlocked,
  validDialNumber,
} from "@/lib/comms/voice/outbound-compliance";
import {
  dialerActivityId,
  dialerAuthToken,
  dialerEnabled,
  dialerGateOn,
  dialerGateRefusal,
  dialerStatusUrl,
  dialerTwilioReady,
  errText,
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
 * plays its application-error message), dialerConfig.enabled re-check,
 * dedicated Twilio still switched on (`subAccountTwilioIsConfigured`), the
 * caller (`From: client:<uid>`, the identity we minted into the token) can
 * still act on the contact (active member or agency owner, territory scope —
 * `requireContactAccessible`, as on every other comms route), the contact
 * belongs to this sub-account, its stored phone is in strict "+…" form ("+",
 * then only digits and space ( ) - . / — `storedInInternationalForm`, the
 * same rule that disables the Call button; checked BEFORE parsing, because
 * libphonenumber would pull "+27…" out of "tel:+27…" or "Mobile: +27…") and
 * is a valid number parsed with no default region, in the Voice
 * channel's `allowedCountries` when one is set — the same two checks, parsed
 * the same way, as the AI outbound path (outbound-compliance.ts) — it has a
 * country (dialer-only: non-geographic numbers are never dialled), and the
 * contact is not `voiceOptedOut` (per contact — a duplicate contact holding
 * the same number is not checked). Each refusal is a spoken rejection +
 * hangup, so the call never leaves Twilio. Only the normalised E.164 is ever
 * dialled.
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
  // Dedicated Twilio switched off (creds kept) stops the dialer too.
  const fromNumber = sub?.twilioConfig?.fromNumber;
  if (!dialerTwilioReady(sub) || !fromNumber) {
    return rejection("The phone number for this workspace is switched off. Goodbye.");
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
  // ONE canonical number. The stored phone must first be in strict "+…" form
  // (the Call button's rule); only then is it parsed, once, with NO default
  // region — the same parse as the AI voice gate. A locally formatted number,
  // or "+…" embedded in other text, is refused
  // rather than guessed at: its meaning would change with the workspace's
  // region setting, and a wrong guess dials a stranger. Validity, the
  // no-country rule, the allow-list and the <Dial> below all read `dialable`
  // — never the stored string.
  const dialable = storedInInternationalForm(contact.phone)
    ? validDialNumber(contact.phone)
    : null;
  if (!dialable) {
    return rejection(
      "That contact's phone number is not a valid international number. Save it in international format, starting with a plus and the country code, then try again. Goodbye.",
    );
  }
  // Dialer-only rule: a number with no country (non-geographic — satellite,
  // +800, +882 international networks) is never dialled, allow-list or not.
  if (!dialable.country) {
    return rejection("Calls to that kind of number aren't supported. Goodbye.");
  }
  const voice = (await getChannelConfig(subAccountId, "voice"))?.voice ?? null;
  if (countryBlocked(dialable.country, voice?.allowedCountries)) {
    return rejection("Calls to that country aren't enabled for this workspace. Goodbye.");
  }
  // Per contact, as upstream: only the dialled contact's own flag is checked.
  if (contact.voiceOptedOut === true) {
    return rejection(
      "This contact has opted out of phone calls, so the call cannot be placed. Goodbye.",
    );
  }

  // Timeline row up-front — the operator sees the call the moment it dials.
  // CallSid becomes part of a document path; a path-shaped one is not written.
  const callSid = params["CallSid"] ?? "";
  if (isDocId(callSid)) {
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
      console.warn("[dialer/twiml] activity write failed", errText(err));
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
  dial.number(dialable.e164);
  return twiml(res);
}
