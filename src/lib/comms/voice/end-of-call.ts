import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { reconcileContactFromCapture } from "@/lib/comms/ai/capture";
import { createCaptureFollowUp } from "@/lib/comms/ai/follow-up";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import { recordUsage } from "@/lib/server/usage-meter";
import type { SubAccountDoc, VoiceCampaignOutcome } from "@/types";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * End-of-call orchestrator for the Vapi voice agent. Called from the
 * `/api/webhooks/vapi/end-of-call/[subAccountId]` route after Vapi has
 * run its post-call analysis (transcript → structured-data extraction
 * + plain-text summary).
 *
 * Mirrors the Web Chat capture pipeline: reconcile a Contact (phone
 * first since voice calls always have caller ID), create a Task due
 * end-of-today, send escalation email. Also writes a single summary
 * doc at `subAccounts/{saId}/voiceCalls/{callId}` so operators can see
 * the call landed and what the bot extracted — no turn-by-turn
 * transcript persistence per the v1 spec.
 *
 * Best-effort throughout: any failure logs but lets the route return
 * 200 to Vapi (Vapi treats 5xx as retryable and we don't want to spam
 * duplicate Tasks / emails).
 */

export interface VapiEndOfCallPayload {
  /** Vapi's per-call id — used as the voiceCalls doc id for natural
   *  dedup on retried webhook deliveries. */
  callId: string;
  /** Caller's phone in E.164. Always present for inbound PSTN calls. */
  callerPhone: string | null;
  /** Number called (our Twilio number). Useful for the operator. */
  toPhone: string | null;
  durationSec: number;
  /** Vapi's plain-text summary. Surfaced in the escalation email + the
   *  voiceCalls doc. */
  summary: string | null;
  /** End-state reported by Vapi: "completed" | "no-answer" | "failed"
   *  | "busy" | "canceled". Free-form — we just stamp whatever
   *  Vapi gave us. */
  endedReason: string | null;
  /** Structured-data extraction from Vapi's analysis plan. May be
   *  empty if Vapi failed to extract anything useful. */
  extracted: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    callbackRequested?: boolean | null;
    /** Outbound only: did the contact express interest in the offer? */
    interested?: boolean | null;
    /** Outbound only: one line on what they were interested in. */
    interestReason?: string | null;
    reason?: string | null;
  };
  /** Normalised transcript turns. The route handler extracts these
   *  from Vapi's payload (handling shape variants) before calling us. */
  transcript: Array<{
    role: "assistant" | "user" | "system";
    content: string;
    secondsFromStart: number | null;
  }>;
  /** "outbound" when this call was placed by our /api/comms/voice/call
   *  route (read from the Vapi call metadata). Undefined for inbound —
   *  the summary doc omits `direction` and consumers treat that as
   *  inbound. We never write a default that could clobber the outbound
   *  placeholder doc the trigger route already wrote. */
  direction?: "outbound";
  /** Contact id stamped into the outbound call's Vapi metadata. Used as
   *  a fallback link when phone reconciliation didn't resolve one. */
  metaContactId?: string | null;
  /** Campaign id when this was a bulk-campaign call — drives writing the
   *  outcome back to the campaign recipient row. */
  metaCampaignId?: string | null;
}

/** Booking correlation stamped on the voiceCalls doc during the call. */
type VoiceBookingStamp = {
  attemptedAt?: string | null;
  booked?: { eventId: string; startAtIso: string } | null;
};

export interface EndOfCallResult {
  contactId: string | null;
  contactCreated: boolean;
  taskId: string | null;
  emailSent: boolean;
  errors: string[];
}

export async function handleVapiEndOfCall(input: {
  subAccountId: string;
  payload: VapiEndOfCallPayload;
}): Promise<EndOfCallResult> {
  const { subAccountId, payload } = input;
  const errors: string[] = [];

  const saSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!saSnap.exists) {
    errors.push("subAccount: not found");
    return {
      contactId: null,
      contactCreated: false,
      taskId: null,
      emailSent: false,
      errors,
    };
  }
  const subAccount = saSnap.data() as SubAccountDoc;

  // Voice Booking correlation the LLM loop stamped during the call (if any).
  // Read before the task block so a booking outcome drives the follow-up.
  let voiceBooking: VoiceBookingStamp | null = null;
  try {
    const callSnap = await getAdminDb()
      .doc(`subAccounts/${subAccountId}/voiceCalls/${payload.callId}`)
      .get();
    voiceBooking =
      (callSnap.data()?.voiceBooking as VoiceBookingStamp | undefined) ?? null;
  } catch {
    voiceBooking = null;
  }

  // Reconciliation inputs. Caller ID phone wins if no explicit callback
  // number was extracted — extracted.phone is only populated when the
  // caller asked for a callback on a DIFFERENT number (per the voice
  // safety rails in prompt.ts).
  const capturedName = sanitize(payload.extracted.name);
  const capturedEmail = sanitize(payload.extracted.email);
  const explicitCallbackPhone = sanitize(payload.extracted.phone);
  const callerPhone = sanitize(payload.callerPhone);
  const capturedPhone = explicitCallbackPhone ?? callerPhone;

  let contactId: string | null = null;
  let contactCreated = false;

  // Only reconcile when we have something durable to act on. If the
  // call ended with no caller-ID phone AND no extracted email, there's
  // nothing meaningful to create a Contact for — just summary-doc it
  // and return.
  if (capturedPhone || capturedEmail) {
    try {
      const reconciled = await reconcileContactFromCapture({
        agencyId: subAccount.agencyId,
        subAccountId,
        existingContactId: null,
        pageUrl: null,
        source: "voice",
        matchStrategy: "phone-first",
        capture: {
          name: capturedName,
          email: capturedEmail,
          phone: capturedPhone,
        },
      });
      if (reconciled) {
        contactId = reconciled.contactId;
        contactCreated = reconciled.created;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(
        `[voice/end-of-call] reconcile failed sa=${subAccountId}`,
        err,
      );
      errors.push(`contact: ${msg}`);
    }
  }

  // Outbound calls already know the contact (the operator dialled them) —
  // fall back to the metadata contact id if phone reconciliation didn't
  // resolve one (e.g. the number on file differs slightly from caller ID).
  if (!contactId && payload.metaContactId) {
    contactId = payload.metaContactId;
  }

  // Decide whether this call needs a follow-up Task, and of what kind:
  //   - Booking completed → "Follow up with" (voice bookings are phone-only,
  //     so NO confirmation email went to the customer — flag that).
  //   - Booking attempted but not completed → "Call back".
  //   - Otherwise, the caller explicitly asked for a callback → "Call back".
  // A caller busy booking never triggers Vapi's `callbackRequested`, which
  // is why the booking correlation (stamped during the call) is checked
  // first. Pure-info calls ("what time do you close?") still create nothing
  // so they don't pollute the operator's Today list. Requires a contactId
  // either way (nothing to attach the Task to otherwise).
  let taskId: string | null = null;
  let emailSent = false;
  const callbackRequested = payload.extracted.callbackRequested === true;

  let followUp:
    | { taskAction: "Follow up with" | "Call back"; note: string | null }
    | null = null;
  if (voiceBooking?.booked) {
    followUp = {
      taskAction: "Follow up with",
      note: `Booked an appointment by phone via the voice agent (it's on the calendar). NOTE: voice bookings are phone-only — NO confirmation email was sent to the customer, so confirm the appointment with them directly.${
        payload.summary ? `\n\nCall summary: ${payload.summary}` : ""
      }`,
    };
  } else if (voiceBooking?.attemptedAt) {
    followUp = {
      taskAction: "Call back",
      note: `Tried to book an appointment by phone but the call ended before one was confirmed. Follow up to lock in a time.${
        payload.summary ? `\n\nCall summary: ${payload.summary}` : ""
      }`,
    };
  } else if (callbackRequested) {
    followUp = { taskAction: "Call back", note: payload.summary };
  }

  if (contactId && followUp) {
    const created = await createCaptureFollowUp({
      agencyId: subAccount.agencyId,
      subAccountId,
      channelId: "voice",
      channelLabel: "Voice",
      taskAction: followUp.taskAction,
      sessionNoun: "call",
      sessionId: payload.callId,
      // v1 has no per-call transcript page — the email button deep-links
      // to the contact only.
      sessionDeepLinkPath: null,
      contactId,
      capturedName,
      capturedEmail,
      capturedPhone,
      lastInboundMessage: followUp.note ?? payload.summary,
      pageUrl: null,
    });
    taskId = created.taskId;
    emailSent = created.emailSent;
    errors.push(...created.errors);
  }

  // ----- Campaign call: write the disposition back to the recipient row.
  // Per the operator's choice, an interested lead creates a follow-up Task
  // ONLY (no auto-email) — a real team member works the queue. -----
  const interested = payload.extracted.interested === true;
  if (payload.metaCampaignId && contactId) {
    const campaignId = payload.metaCampaignId;
    const db = getAdminDb();
    const outcome = deriveCampaignOutcome({
      interested,
      callbackRequested,
      endedReason: payload.endedReason,
      durationSec: payload.durationSec,
      hadConversation: payload.transcript.some((t) => t.role === "user"),
    });

    let campaignTaskId: string | null = null;
    if (interested || callbackRequested) {
      try {
        const campaignSnap = await db.doc(`voiceCampaigns/${campaignId}`).get();
        const code =
          (campaignSnap.data()?.code as string | undefined) ?? "campaign";
        const cname = (campaignSnap.data()?.name as string | undefined) ?? "";
        const label = cname ? `${code} · ${cname}` : code;
        const identity =
          capturedName || capturedPhone || capturedEmail || "this contact";
        const now = new Date();
        const dueAt = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          23,
          59,
          59,
        );
        // Through the shared chokepoint so `task.created` fires and the
        // `mode` field is set (a raw add left the task invisible to the
        // public API's mode filter). Territory resolves inside the service.
        const created = await createTaskServerSide({
          subAccountId,
          agencyId: subAccount.agencyId,
          createdByUid: "voice-campaign-bot",
          mode: "live",
          title: `Follow up: ${interested ? "interested" : "callback"} — ${identity} (${label})`,
          notes: [
            `Outbound AI campaign call: ${label}`,
            payload.extracted.interestReason
              ? `Interest: ${payload.extracted.interestReason}`
              : null,
            payload.summary ? `\nCall summary:\n"${payload.summary}"` : null,
          ]
            .filter(Boolean)
            .join("\n"),
          dueAt,
          contactId,
          dealId: null,
          eventId: null,
        });
        campaignTaskId = created.id;
      } catch (err) {
        console.error(
          `[voice/end-of-call] campaign task failed sa=${subAccountId}`,
          err,
        );
        errors.push(
          `campaign-task: ${err instanceof Error ? err.message : "error"}`,
        );
      }
    }

    try {
      await db
        .doc(`voiceCampaigns/${campaignId}/recipients/${contactId}`)
        .update({
          outcome,
          callDurationSec: payload.durationSec,
          endedReason: payload.endedReason,
          callSummary: payload.summary,
          taskId: campaignTaskId,
        });
      if (interested) {
        await db
          .doc(`voiceCampaigns/${campaignId}`)
          .update({ "totals.interested": FieldValue.increment(1) })
          .catch(() => {});
      }
    } catch (err) {
      console.error(
        `[voice/end-of-call] campaign recipient update failed sa=${subAccountId}`,
        err,
      );
      errors.push(
        `campaign-recipient: ${err instanceof Error ? err.message : "error"}`,
      );
    }
  }

  // Always write the voiceCalls summary doc — gives operators visibility
  // into every call even when no Contact was created (e.g. wrong number,
  // hang-up, info-only). Doc id = Vapi callId for natural dedup on
  // retried webhook deliveries.
  try {
    await getAdminDb()
      .doc(`subAccounts/${subAccountId}/voiceCalls/${payload.callId}`)
      .set(
        {
          agencyId: subAccount.agencyId,
          subAccountId,
          callId: payload.callId,
          // Only stamp direction when we positively know it's outbound
          // (from call metadata). Inbound omits it; merge preserves the
          // outbound placeholder the trigger route wrote either way.
          ...(payload.direction === "outbound"
            ? { direction: "outbound" as const }
            : {}),
          callerPhone: callerPhone,
          toPhone: sanitize(payload.toPhone),
          durationSec: payload.durationSec,
          summary: payload.summary,
          endedReason: payload.endedReason,
          contactId,
          contactCreated,
          callbackRequested,
          capturedName,
          capturedEmail,
          capturedPhone,
          taskId,
          escalationEmailSent: emailSent,
          transcript: payload.transcript,
          errors,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[voice/end-of-call] summary doc write failed sa=${subAccountId}`,
      err,
    );
    errors.push(`summary: ${msg}`);
  }

  // Usage Metering v1 — every call (inbound + outbound) lands here once
  // (doc id = callId dedupes retried webhook deliveries upstream).
  runAfterResponse(() => recordUsage({
    subAccountId,
    unit: "voiceSeconds",
    qty: payload.durationSec,
    subAccount,
  }));

  // Trace the call on the contact — the timeline is the first place an
  // operator looks, and an AI-answered call previously left nothing there.
  if (contactId) {
    try {
      const mins = Math.floor(payload.durationSec / 60);
      const secs = payload.durationSec % 60;
      const dur = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      await getAdminDb()
        .collection("contacts")
        .doc(contactId)
        .collection("activities")
        .add({
          type: "voice_call_completed",
          content: `${payload.direction === "outbound" ? "Outbound" : "Inbound"} AI call (${dur})${
            payload.summary ? ` — ${payload.summary.slice(0, 200)}` : ""
          }`,
          createdBy: "voice-agent",
          meta: { callId: payload.callId, endedReason: payload.endedReason ?? null },
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn(
        `[voice/end-of-call] activity write failed sa=${subAccountId}`,
        err,
      );
      errors.push("activity: write failed");
    }
  }

  // Emit public-API webhook events so external subscribers (Slack via
  // Zapier, custom servers, etc.) see voice activity in real time. Fire-
  // and-forget — dispatch failures must not affect the Vapi response.
  // Always emit `voice.call.completed`; additionally emit
  // `voice.call.captured` when the call produced contact identity, so
  // subscribers can filter for "hot" voice events.
  runAfterResponse(() => emitWebhookEvent({
    subAccountId,
    agencyId: subAccount.agencyId,
    mode: "live",
    type: "voice.call.completed",
    payload: {
      call: {
        id: payload.callId,
        object: "voice_call",
        caller_phone: callerPhone,
        to_phone: sanitize(payload.toPhone),
        duration_seconds: payload.durationSec,
        summary: payload.summary,
        ended_reason: payload.endedReason,
        contact_id: contactId,
        callback_requested: callbackRequested,
        ended_at: new Date().toISOString(),
      },
    },
  }));
  if (contactId && (capturedEmail || capturedName || capturedPhone)) {
    runAfterResponse(() => emitWebhookEvent({
      subAccountId,
      agencyId: subAccount.agencyId,
      mode: "live",
      type: "voice.call.captured",
      payload: {
        call: {
          id: payload.callId,
          object: "voice_call",
          caller_phone: callerPhone,
          summary: payload.summary,
          contact_id: contactId,
        },
        captured: {
          name: capturedName,
          email: capturedEmail,
          phone: capturedPhone,
          callback_requested: callbackRequested,
        },
      },
    }));
  }

  return { contactId, contactCreated, taskId, emailSent, errors };
}

function sanitize(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
}

/** Map the call's signals to a single campaign outcome disposition. */
function deriveCampaignOutcome(input: {
  interested: boolean;
  callbackRequested: boolean;
  endedReason: string | null;
  durationSec: number;
  hadConversation: boolean;
}): VoiceCampaignOutcome {
  if (input.interested) return "interested";
  if (input.callbackRequested) return "callback";
  const reason = (input.endedReason ?? "").toLowerCase();
  if (reason.includes("voicemail")) return "voicemail";
  if (
    reason.includes("no-answer") ||
    reason.includes("noanswer") ||
    reason.includes("did-not-answer") ||
    reason.includes("not-answer")
  ) {
    return "no_answer";
  }
  if (
    reason.includes("busy") ||
    reason.includes("failed") ||
    reason.includes("error")
  ) {
    return "failed";
  }
  // Connected but no real exchange → treat as no-answer rather than a
  // declined lead.
  if (!input.hadConversation || input.durationSec < 5) return "no_answer";
  return "not_interested";
}
