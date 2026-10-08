import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getAgentProfile, getChannelConfig } from "@/lib/comms/ai/agent";
import { vapiIsConfigured, createOutboundCall, VapiError } from "@/lib/comms/voice/vapi";
import type { SubAccountDoc } from "@/types";
import type { VoiceChannelConfig } from "@/types/ai";

/**
 * An outbound AI voice call to a contact, shared by POST /api/comms/voice/call
 * and the agent's start_voice_call: the workspace gates (agency, the Voice
 * channel, Vapi and a provisioned number), then placing the call and the
 * records it leaves (the voiceCalls placeholder, the activity row, the
 * contact's last-call stamp). Compliance runs in the caller, between the two.
 */

export type VoiceReady = { ok: true; voice: VoiceChannelConfig & { vapiAssistantId: string; vapiPhoneNumberId: string }; agentTimezone: string };

export async function outboundVoiceReady(subAccountId: string): Promise<VoiceReady | { ok: false; status: number; error: string }> {
  const saSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const subAccount = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
  if (subAccount?.outboundVoiceEnabledByAgency !== true) {
    return { ok: false, status: 403, error: "Outbound calling is disabled for this workspace. Ask your agency owner to enable it." };
  }
  const voice = (await getChannelConfig(subAccountId, "voice"))?.voice ?? null;
  if (!voice || voice.outboundEnabled !== true) return { ok: false, status: 403, error: "Outbound calling isn't enabled in the Voice settings." };
  if (!vapiIsConfigured()) return { ok: false, status: 503, error: "Voice calling isn't configured on this deployment." };
  if (!voice.vapiAssistantId || !voice.vapiPhoneNumberId) {
    return { ok: false, status: 400, error: "Enable the Voice channel first so the calling number is provisioned." };
  }
  const profile = await getAgentProfile(subAccountId);
  return {
    ok: true,
    voice: voice as VoiceReady["voice"],
    agentTimezone: profile?.timezone || voice.outboundWindow?.timezone || "UTC",
  };
}

/** Place the call (the inbound assistant + number) and leave its records. */
export async function placeContactCall(opts: {
  contact: { agencyId: string; subAccountId: string };
  contactId: string;
  uid: string;
  voice: VoiceReady["voice"];
  customerNumber: string;
  /** A mystery-shop call: its enquiry as the first message, its id in the call metadata, a length cap. */
  mysteryShop?: { id: string; firstMessage: string; maxDurationSeconds: number };
}): Promise<{ ok: true; callId: string } | { ok: false; error: string; uncertain: boolean }> {
  const { contact, contactId, voice, customerNumber, mysteryShop } = opts;
  const db = getAdminDb();
  let callId: string;
  try {
    const result = await createOutboundCall({
      assistantId: voice.vapiAssistantId,
      phoneNumberId: voice.vapiPhoneNumberId,
      customerNumber,
      contactId,
      firstMessage: mysteryShop?.firstMessage ?? voice.outboundFirstMessage,
      ...(mysteryShop ? { mysteryShopId: mysteryShop.id, maxDurationSeconds: mysteryShop.maxDurationSeconds } : {}),
    });
    callId = result.callId;
  } catch (err) {
    // A Vapi 4xx (or our missing key) placed nothing; a network error or a 5xx may have.
    const placedNothing = err instanceof VapiError && (err.status < 500 || !err.body);
    return { ok: false, error: err instanceof Error ? err.message : "Failed to place the call", uncertain: !placedNothing };
  }

  // Placeholder so the per-number / daily caps count this call immediately
  // and the operator console shows it before the end-of-call report lands.
  try {
    await db.doc(`subAccounts/${contact.subAccountId}/voiceCalls/${callId}`).set(
      {
        id: callId, agencyId: contact.agencyId, subAccountId: contact.subAccountId, callId, direction: "outbound",
        callerPhone: customerNumber, toPhone: null, durationSec: 0, summary: null, endedReason: null, contactId,
        contactCreated: false, callbackRequested: false, capturedName: null, capturedEmail: null, capturedPhone: null,
        taskId: null, escalationEmailSent: false, transcript: [], liveStatus: "queued", liveStatusAt: FieldValue.serverTimestamp(),
        initiatedByUid: opts.uid, consentAck: true, errors: [], createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } catch (err) {
    console.warn("[voice/call] placeholder doc write failed", err);
  }
  try {
    await db.collection("contacts").doc(contactId).collection("activities").add({
      type: "voice_call_initiated",
      content: "Outbound AI call placed",
      createdBy: opts.uid,
      meta: { callId },
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn("[voice/call] activity write failed", err);
  }
  await db
    .collection("contacts")
    .doc(contactId)
    .update({ lastOutboundCallAt: FieldValue.serverTimestamp(), lastOutboundCampaignId: null })
    .catch((err) => console.warn("[voice/call] contact stamp failed", err));
  return { ok: true, callId };
}
