import { NextResponse } from "next/server";

import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { checkOutboundCompliance } from "@/lib/comms/voice/outbound-compliance";
import { outboundVoiceReady, placeContactCall } from "@/lib/server/voice-call";

type Body = { contactId?: string; consentAck?: boolean };

/**
 * Place an outbound AI voice call to a contact (operator-initiated
 * click-to-call). Mirrors the SMS send route's auth + 503 pattern.
 *
 * Gates, in order:
 *   1. Authenticated + can access the contact.
 *   2. Agency gate `outboundVoiceEnabledByAgency === true` (403 otherwise).
 *   3. Voice channel `voice.outboundEnabled === true` (403 otherwise).
 *   4. Vapi configured + the inbound assistant/number provisioned (503/400).
 *   5. Native compliance gate (opt-out, consent, window, caps) — 422 with
 *      a machine-readable `code` + human `reason` when it blocks. No Vapi
 *      minutes are spent on a blocked call.
 *
 * On success: places the call (reusing the inbound assistant + number),
 * writes a `voiceCalls/{callId}` placeholder doc (direction "outbound",
 * linked to the contact) so the per-number/daily caps count it and the
 * operator console shows it, plus a `voice_call_initiated` activity row.
 */
export async function POST(request: Request) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contactId = payload.contactId?.trim();
  if (!contactId) {
    return NextResponse.json(
      { error: "contactId is required" },
      { status: 400 },
    );
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  const ready = await outboundVoiceReady(contact.subAccountId);
  if (!ready.ok) {
    return NextResponse.json({ error: ready.error }, { status: ready.status });
  }
  const { voice, agentTimezone } = ready;

  const compliance = await checkOutboundCompliance({
    subAccountId: contact.subAccountId,
    contact,
    voice,
    agentTimezone,
    consentAck: payload.consentAck === true,
  });
  if (!compliance.allowed) {
    return NextResponse.json(
      {
        ok: false,
        code: compliance.code,
        error: compliance.reason,
        retryAfterSec: compliance.retryAfterSec ?? null,
      },
      { status: 422 },
    );
  }

  const customerNumber = compliance.e164 ?? contact.phone;

  // Place the call.
  const placed = await placeContactCall({ contact, contactId, uid: auth.uid, voice, customerNumber });
  if (!placed.ok) {
    return NextResponse.json({ ok: false, error: placed.error }, { status: 502 });
  }
  const { callId } = placed;

  return NextResponse.json({ ok: true, callId });
}
