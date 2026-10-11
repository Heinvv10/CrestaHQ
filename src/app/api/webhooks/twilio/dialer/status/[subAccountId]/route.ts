import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import twilio from "twilio";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import {
  dialerActivityId,
  dialerAuthToken,
  errText,
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
 * behind `dialerEnabledByAgency`, nor behind the dedicated-Twilio switch: a
 * call already placed when either is switched off still gets its outcome
 * recorded. It only ever updates a row for a contact in this sub-account.
 *
 * The body is signed by the tenant's own token, so its values are still
 * checked: `contactId` and `CallSid` must be plain document ids (else nothing
 * is written — the answer is still 200), the status must be one Twilio
 * documents, the duration is clamped, and a RecordingUrl is stored only when
 * this sub-account has recording on and the URL is exactly a recording on its
 * own Twilio account ({@link ownRecordingUrl}).
 */

/** Twilio's longest call is 24 hours. */
const MAX_CALL_SECONDS = 86_400;
const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;

/**
 * The RecordingUrl, only when it is exactly a recording on THIS sub-account's
 * own Twilio account at api.twilio.com: nothing before or after it, no other
 * account's SID, no other host. Regional hosts (api.ie1.twilio.com …) are not
 * accepted. A missing or mis-shaped account SID stores nothing.
 */
function ownRecordingUrl(raw: string, accountSid: unknown): string | null {
  if (typeof accountSid !== "string" || !ACCOUNT_SID.test(accountSid)) return null;
  const sid = accountSid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = new RegExp(
    `^https://api\\.twilio\\.com/2010-04-01/Accounts/${sid}/Recordings/RE[0-9a-f]{32}(\\.(mp3|wav))?$`,
  );
  return exact.test(raw) ? raw : null;
}

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

  // Everything below is caller-supplied (signed, but by the tenant's own
  // token): each value is checked before it reaches a path or the document.
  const contactId = new URL(request.url).searchParams.get("contactId") ?? "";
  const callSid = params["CallSid"] ?? "";
  const rawStatus = params["DialCallStatus"] ?? "";
  const dialStatus = Object.hasOwn(OUTCOME_LABEL, rawStatus) ? rawStatus : "ended";
  const rawDuration = Number(params["DialCallDuration"]);
  const durationSec = Number.isFinite(rawDuration)
    ? Math.min(Math.max(Math.floor(rawDuration), 0), MAX_CALL_SECONDS)
    : 0;
  const recordingUrl =
    sub?.dialerConfig?.recordCalls === true
      ? ownRecordingUrl(params["RecordingUrl"] ?? "", sub.twilioConfig?.accountSid)
      : null;

  // Both ids become document-path segments; a path-shaped one is not written.
  if (isDocId(contactId) && isDocId(callSid)) {
    const outcome = OUTCOME_LABEL[dialStatus] ?? "ended";
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
              status: dialStatus,
              durationSec,
              // Twilio-hosted media. Publicly fetchable by anyone holding the
              // URL unless the account enables "Enforce HTTP Auth on Media URLs".
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
      console.warn("[dialer/status] activity update failed", errText(err));
    }
  }

  const res = new twilio.twiml.VoiceResponse();
  res.hangup();
  return new NextResponse(res.toString(), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
