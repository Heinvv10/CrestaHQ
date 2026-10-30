import "server-only";

import { NextResponse } from "next/server";
import twilio from "twilio";
import {
  handleMissedCall,
  isMissedDialStatus,
  normalisePhone,
  resolveVoiceRoute,
} from "@/lib/comms/missed-call";

export const dynamic = "force-dynamic";

/**
 * Missed Call Text Back — the <Dial> action / status callback.
 *
 * Twilio POSTs here when the forwarded call finishes, carrying `DialCallStatus`
 * plus the ORIGINAL call's From (the caller) / To (our number) / CallSid. If
 * the forward didn't reach a human (no-answer / busy / failed / canceled) we
 * fire the text-back via `handleMissedCall`; otherwise we do nothing. Always
 * returns 200 empty TwiML to end the call — the text-back runs server-side.
 */

function xml(body: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

const EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export async function POST(request: Request) {
  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody).entries());

  const to = normalisePhone((params["To"] as string | undefined) ?? "");
  const from = normalisePhone((params["From"] as string | undefined) ?? "");
  const callSid = (params["CallSid"] as string | undefined) ?? "";
  const dialStatus = (params["DialCallStatus"] as string | undefined) ?? "";

  const route = await resolveVoiceRoute(to);
  if (!route) return xml(EMPTY);

  // Verify Twilio's signature against the sub-account's auth token.
  const signature = request.headers.get("x-twilio-signature");
  if (!signature) return xml(EMPTY);
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const url = new URL(request.url);
  const fullUrl = `${proto}://${host ?? url.host}${url.pathname}`;
  const valid = twilio.validateRequest(
    route.authToken,
    signature,
    fullUrl,
    params,
  );
  if (!valid) {
    console.warn(
      `[twilio/voice/status] invalid signature (sa=${route.subAccountId})`,
    );
    return new NextResponse("Invalid signature", { status: 403 });
  }

  // Only text back when the forward genuinely missed the human.
  if (!isMissedDialStatus(dialStatus)) {
    return xml(EMPTY);
  }

  try {
    const result = await handleMissedCall({ route, from, callSid });
    if (!result.handled) {
      console.warn(
        `[twilio/voice/status] not handled (sa=${route.subAccountId}, reason=${result.reason})`,
      );
    }
  } catch (err) {
    // Never break the webhook contract — log and return 200.
    console.error(
      `[twilio/voice/status] handler failed (sa=${route.subAccountId})`,
      err,
    );
  }

  return xml(EMPTY);
}
