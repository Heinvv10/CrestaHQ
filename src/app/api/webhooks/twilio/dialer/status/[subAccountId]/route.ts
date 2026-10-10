import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import twilio from "twilio";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  dialerActivityId,
  dialerAuthToken,
  formatCallDuration,
  validateDialerSignature,
} from "@/lib/comms/dialer";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Softphone v1 — the <Dial action> callback: fires once when the dialed leg
 * ends. Updates the `call_placed` activity row (created by the TwiML route)
 * with the outcome, duration, and — when recording is on — the RecordingUrl.
 * The `?contactId=…` query travels on the action URL (and is covered by the
 * Twilio signature — validateDialerSignature keeps the query string).
 * Responds <Hangup/> so the operator's leg ends cleanly with the call.
 *
 * Signature checked against the sub-account's auth token from
 * `private/twilioCredentials` (`readSubAccountSecret`). Deliberately NOT
 * behind `dialerEnabledByAgency`: a call already placed when the gate is
 * switched off still gets its outcome recorded. It only ever updates a row
 * for a contact in this sub-account.
 */

const OUTCOME_LABEL: Record<string, string> = {
  completed: "completed",
  answered: "completed",
  busy: "busy",
  "no-answer": "no answer",
  failed: "failed",
  canceled: "canceled",
};

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
  if (!authToken) return new NextResponse("Unknown sub-account", { status: 404 });
  if (!validateDialerSignature({ request, authToken, params })) {
    return new NextResponse("Invalid signature", { status: 403 });
  }

  const contactId = new URL(request.url).searchParams.get("contactId") ?? "";
  const callSid = params["CallSid"] ?? "";
  const dialStatus = params["DialCallStatus"] ?? "";
  const durationSec = Number(params["DialCallDuration"] ?? "0") || 0;
  const recordingUrl = params["RecordingUrl"] || null;

  if (contactId && callSid) {
    const outcome = OUTCOME_LABEL[dialStatus] ?? (dialStatus || "ended");
    const content =
      outcome === "completed"
        ? `Phone call — ${formatCallDuration(durationSec)}`
        : `Phone call — ${outcome}`;
    try {
      const contactRef = db.collection("contacts").doc(contactId);
      const contactSnap = await contactRef.get();
      if (
        contactSnap.exists &&
        contactSnap.data()?.subAccountId === subAccountId
      ) {
        const activityRef = contactRef
          .collection("activities")
          .doc(dialerActivityId(callSid));
        // Backfill createdAt if the TwiML-route write blipped — the timeline
        // orders by createdAt, so a doc without it would never render.
        const existing = await activityRef.get();
        await activityRef.set(
          {
            type: "call_placed",
            content,
            meta: {
              callSid,
              status: dialStatus || "ended",
              durationSec,
              // Twilio-hosted media — opening it requires Twilio login.
              ...(recordingUrl ? { recordingUrl } : {}),
            },
            ...(existing.exists
              ? {}
              : {
                  createdBy: "dialer",
                  createdAt: FieldValue.serverTimestamp(),
                }),
          },
          { merge: true },
        );
      }
    } catch (err) {
      console.warn("[dialer/status] activity update failed", err);
    }
  }

  const res = new twilio.twiml.VoiceResponse();
  res.hangup();
  return new NextResponse(res.toString(), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
