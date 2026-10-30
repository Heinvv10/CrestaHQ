import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  sendSmsForSubAccount,
  smsIsConfigured,
  subAccountTwilioIsConfigured,
  sendWhatsappTemplateForSubAccount,
} from "@/lib/comms/twilio";
import { checkWhatsappReadiness } from "@/lib/comms/whatsapp/readiness";
import { capabilitiesFor } from "@/lib/comms/whatsapp/provider";
import { sendWhatsappFreeFormForSubAccount } from "@/lib/comms/whatsapp/send-dispatch";
import { isWithinServiceWindow } from "@/lib/comms/whatsapp/send-mode";
import { dispatchWhatsappTemplateSend } from "@/lib/comms/whatsapp/template-dispatch";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import {
  DEFAULT_REVIEW_COOLDOWN_DAYS,
  DEFAULT_REVIEW_SMS_TEMPLATE,
  normalizeReviewChannel,
  type ReviewChannel,
} from "@/lib/reviews/constants";
import { resolveReviewUrl } from "@/lib/reviews/canonical-url";
import { logReviewRequest } from "@/lib/reviews/request-log";
import { planReviewLink, scheduleReviewReminder, supersedeOtherReminders } from "@/lib/reviews/reminder";
import { phoneHash, templateHash } from "@/lib/reviews/reminder-checks";
import { normalizePhoneE164 } from "@/lib/contacts/phone";
import { isGoogleReviewUrl } from "@/lib/reviews/review-url";
import { isMain } from "@/lib/gbp/listings";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import type { ConversationChannel } from "@/types/conversations";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";
import {
  QuietHoursDeferredError,
  isQuietHoursDeferred,
  type QuietHoursHold,
} from "@/lib/comms/quiet-hours";
import { holdForQuietHours } from "@/lib/comms/quiet-hours-hold";
import { fillPositional, reviewBodyNow, reviewSmsBody, reviewTemplateFill } from "@/lib/reviews/review-body";

/**
 * Google review-request dispatcher. Sends a "leave us a review" message over
 * SMS or WhatsApp to a contact, then logs it on the timeline + conversation.
 *
 * Reuses the same send + persist paths as the manual comms routes (message row
 * + unified-inbox upsert), so a review request shows up in the contact thread
 * and the inbox like any other outbound. Best-effort: returns a reason instead
 * of throwing, so the quote-paid hook can `void` it safely.
 *
 * SMS is free-form. WhatsApp is business-initiated outside the 24h window → it
 * MUST use an approved template (review URL baked into the approved body), sent
 * via Twilio's contentSid path. The settings save route + this dispatcher both
 * enforce that, so a non-compliant WhatsApp send is impossible.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReviewTrigger = "manual" | "quote_paid" | "deal_completed" | "reminder";

export interface SendReviewInput {
  subAccountId: string;
  agencyId: string;
  contactId: string;
  trigger: ReviewTrigger;
  /** The signed-in sender of a manual send; the log's `createdByUid`. */
  actorUid?: string;
  /** SP5 d2: a reminder re-send of this request (trigger "reminder") — same
   *  link, no cooldown, no new log row; the worker records the attempt. */
  reminderOf?: { requestId: string; tracked: boolean; channel: "sms" | "whatsapp" };
  /** What a person approved (an agent's mark_deal_completed): the send is
   *  refused if the contact's number, the configured channel or the text now
   *  differs, here or when a quiet-hours hold releases it; and it never
   *  schedules reminders. Absent for every other caller. */
  expect?: { phone: string; channel: ReviewChannel; body: string; /** whatsapp_template only. */ fingerprint?: string };
  /** MULTI_LISTING_V1_PLAN.md PR 5: the listing asked about. Absent or the
   *  main listing = today's send; an EXTRA sends its own adopted link only
   *  (else `listing_url_not_configured`), free-form channels only (else
   *  `listing_needs_template`), with no reminder or click tracking in v1. */
  locationName?: string;
}

export interface SendReviewResult {
  sent: boolean;
  /** When sent is false: not_configured | trigger_disabled | no_contact |
   *  no_phone | opted_out | cooldown | sms_not_configured | whatsapp_gate_off |
   *  whatsapp_not_configured | window_closed | rail_has_no_templates |
   *  no_template | template_not_approved | template_var_missing |
   *  send_failed | error | quiet_hours_held | quiet_hours (reminder: the
   *  worker reschedules itself with `quietHours`) | changed_since_approval |
   *  listing_url_not_configured | listing_needs_template */
  reason?: string;
  /** Set with reason "quiet_hours": when the quiet window ends. */
  quietHours?: QuietHoursHold;
}

function toMillis(v: unknown): number | null {
  const maybe = v as { toMillis?: () => number } | null | undefined;
  return maybe && typeof maybe.toMillis === "function" ? maybe.toMillis() : null;
}

export async function maybeSendReviewRequest(
  input: SendReviewInput,
): Promise<SendReviewResult> {
  try {
    const db = getAdminDb();
    const subSnap = await db.doc(`subAccounts/${input.subAccountId}`).get();
    const subAccount = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
    const cfg = subAccount?.googleReviewConfig ?? null;
    const extraListing = subAccount && input.locationName && !isMain(subAccount, input.locationName) ? input.locationName : null;
    // The configured URL only — a listing's proposed link is never sent.
    const reviewUrl = resolveReviewUrl(subAccount, input.locationName).configured;
    if (extraListing && cfg && !reviewUrl) return { sent: false, reason: "listing_url_not_configured" };
    if (!subAccount || !cfg || !reviewUrl) {
      return { sent: false, reason: "not_configured" };
    }

    const isManual = input.trigger === "manual";
    // A person pressing "send" goes now; every other trigger is held during
    // the workspace's quiet hours (lib/comms/quiet-hours.ts).
    const origin = isManual ? ("manual" as const) : ("automated" as const);
    // A reminder re-sends a request already made; its trigger's gate was checked then.
    const isReminder = input.trigger === "reminder" && !!input.reminderOf;
    if (!isManual && !isReminder) {
      // Each auto trigger is gated by `enabled` + its own per-trigger flag.
      const triggerEnabled =
        input.trigger === "quote_paid"
          ? cfg.triggerOnQuotePaid === true
          : input.trigger === "deal_completed"
            ? cfg.triggerOnDealCompleted === true
            : false;
      if (!(cfg.enabled && triggerEnabled)) {
        return { sent: false, reason: "trigger_disabled" };
      }
    }

    const contactSnap = await db.doc(`contacts/${input.contactId}`).get();
    // A linked id from a legacy doc may name another tenant's contact.
    if (!contactSnap.exists || contactSnap.data()?.subAccountId !== input.subAccountId) {
      return { sent: false, reason: "no_contact" };
    }
    const contact = {
      id: contactSnap.id,
      ...(contactSnap.data() as Omit<Contact, "id">),
    };
    if (!contact.phone) return { sent: false, reason: "no_phone" };

    const channel = normalizeReviewChannel(cfg.channel);
    // An approved template carries the main listing's link in its body.
    if (extraListing && channel !== "sms" && channel !== "whatsapp_manual") {
      return { sent: false, reason: "listing_needs_template" };
    }
    // The template fill an approved send was checked against, sent as is.
    let approvedTemplate: { tpl: WhatsappTemplateDoc; values: string[] } | undefined;
    if (input.expect) {
      const now = await reviewBodyNow({ db, subAccountId: input.subAccountId, subAccount, cfg, channel, contact, reviewUrl });
      if (
        contact.phone !== input.expect.phone ||
        channel !== input.expect.channel ||
        !now.ok ||
        now.body !== input.expect.body ||
        (channel === "whatsapp_template" && now.template?.fingerprint !== input.expect.fingerprint)
      ) {
        return { sent: false, reason: "changed_since_approval" };
      }
      approvedTemplate = now.template;
    }
    const isWhatsapp = channel !== "sms";
    const convoChannel: ConversationChannel = isWhatsapp ? "whatsapp" : "sms";
    // A reminder goes only on the channel its request went on.
    if (isReminder && convoChannel !== input.reminderOf!.channel) return { sent: false, reason: "channel_changed" };

    // Per-channel opt-out.
    if (channel === "sms" && smsSendBlock(contact)) {
      return { sent: false, reason: "opted_out" };
    }
    if (isWhatsapp && contact.whatsappOptedOut) {
      return { sent: false, reason: "opted_out" };
    }

    // Cooldown — auto only; manual (operator intent) and a reminder of THIS
    // request bypass it, but still stamp.
    if (!isManual && !isReminder) {
      const cooldownDays =
        cfg.cooldownDays > 0 ? cfg.cooldownDays : DEFAULT_REVIEW_COOLDOWN_DAYS;
      const lastMs = toMillis(contact.reviewRequestedAt);
      if (lastMs && Date.now() - lastMs < cooldownDays * DAY_MS) {
        return { sent: false, reason: "cooldown" };
      }
    }

    const businessName = subAccount.name ?? "";
    // SP5 d2: reminders off (the default) → null, and every body below is as before.
    // An approved agent send (expect) never starts reminders: each would be
    // rendered later, unreviewed. With no plan the link is the configured
    // one (tracking exists only for reminders), so the text is as approved.
    const plan = input.expect || extraListing ? null : planReviewLink({
      config: cfg,
      channel,
      subAccountId: input.subAccountId,
      reviewUrl,
      reminderOf: isReminder ? input.reminderOf : undefined,
      remindable:
        subAccountTwilioIsConfigured(subAccount.twilioConfig) &&
        subAccount.twilioConfig?.inboundWebhookConfigured === true &&
        normalizePhoneE164(contact.phone) === contact.phone &&
        isGoogleReviewUrl(reviewUrl),
      newRequestId: () => db.collection(`subAccounts/${input.subAccountId}/reviewRequests`).doc().id,
    });
    const bodyUrl = plan?.bodyUrl ?? reviewUrl;

    // ---- Send (channel-specific) ----
    let sid: string;
    let fromNumber: string;
    let renderedBody: string;
    let writeRow = false;
    let messagesCollection = "messages";

    if (isWhatsapp) {
      messagesCollection = "whatsappMessages";
      // Both WhatsApp modes need the agency gate + a configured sender.
      if (subAccount.whatsappEnabledByAgency !== true) {
        return { sent: false, reason: "whatsapp_gate_off" };
      }
      // Readiness is PER RAIL. The old Twilio-shaped credential check refused
      // every correctly connected Cloud or bridge workspace and told the
      // operator to add a Twilio number, which is not the fix on either rail.
      // The two send helpers below (sendWhatsappFreeFormForSubAccount,
      // dispatchWhatsappTemplateSend) are themselves rail-agnostic — but this
      // gate was NOT the only rail-blind check on the path, so converting it
      // alone would only have moved the refusal one line down: the
      // whatsapp_manual branch refused a shut 24h window on every rail
      // (the bridge has no window), and the whatsapp_template branch had no
      // answer for a rail with no templates. All three are per-rail below —
      // the window and template checks read `capabilitiesFor`, this gate is
      // rail-aware in its own right (per-rail credentials and health). Same
      // readiness call the workflow engine's WhatsApp executors make, so the
      // two agree.
      const readiness = await checkWhatsappReadiness({
        subAccountId: input.subAccountId,
        subAccount,
      });
      if (!readiness.ready) {
        return { sent: false, reason: "whatsapp_not_configured" };
      }

      const freeFormBody = reviewSmsBody(cfg, contact, businessName, bodyUrl);

      if (channel === "whatsapp_manual") {
        // Free-form. No approved template required. Read the window ONCE and
        // hand the timestamp to the dispatcher: letting each re-read it would
        // mean two queries that can disagree — and the caller needs the answer
        // anyway, to report `window_closed` rather than a generic send failure.
        const lastInboundAt = await whatsappLastInboundAt(db, contact.id);
        // Whether a shut window refuses the send is a CAPABILITY of the rail,
        // not a special case for one provider. A rail outside Meta's system
        // has no service window at all, and `resolveWaSendMode` — which the
        // dispatcher below runs — reads `enforcesWindow` exactly this way.
        // Refusing unconditionally here would admit the bridge past the
        // readiness gate only to turn it away at this one.
        if (
          capabilitiesFor(readiness.provider).enforcesWindow &&
          !isWithinServiceWindow(lastInboundAt, new Date())
        ) {
          return { sent: false, reason: "window_closed" };
        }
        const res = await sendWhatsappFreeFormForSubAccount({
          subAccountId: input.subAccountId,
          subAccount,
          contactId: contact.id,
          to: contact.phone,
          body: freeFormBody,
          lastInboundAt,
          origin,
        });
        sid = res.sid;
        fromNumber = res.from;
        renderedBody = freeFormBody;
      } else {
        // whatsapp_template — approved template (compliant outside the window).
        // The bridge has no templates at all, so the configured send can never
        // run there. That is a different fact from "your template was not
        // approved" and has a different fix (switch rail, or use the in-window
        // mode), so it gets its own reason rather than borrowing that one.
        if (!capabilitiesFor(readiness.provider).supportsTemplates) {
          return { sent: false, reason: "rail_has_no_templates" };
        }
        if (!cfg.whatsappTemplateId) return { sent: false, reason: "no_template" };
        // Approval is per-rail: a template cleared through Twilio's BSP has
        // never been seen by our own WABA, so "approved" alone is not enough.
        const filled = approvedTemplate
          ? { ok: true as const, ...approvedTemplate }
          : await reviewTemplateFill(db, input.subAccountId, cfg.whatsappTemplateId, contact, subAccount);
        if (!filled.ok) return { sent: false, reason: filled.reason };
        const { tpl, values } = filled;
        let templateFrom = "";
        const res = await dispatchWhatsappTemplateSend({
          subAccountId: input.subAccountId,
          subAccount,
          to: contact.phone,
          template: tpl,
          values,
          origin,
          sendViaTwilio: async (contentSid) => {
            const r = await sendWhatsappTemplateForSubAccount({
              subAccountId: input.subAccountId,
              subAccount,
              to: contact.phone,
              contentSid,
              contentVariables: values,
            });
            templateFrom = r.from;
            return { ok: true, messageId: r.sid };
          },
        });
        if (res.quietHours) throw new QuietHoursDeferredError(res.quietHours);
        if (!res.ok) return { sent: false, reason: "template_not_approved" };
        sid = res.messageId ?? "";
        fromNumber = templateFrom;
        renderedBody = fillPositional(tpl.body, values);
      }
      writeRow = true;
    } else {
      const dedicated = subAccountTwilioIsConfigured(subAccount.twilioConfig);
      if (!dedicated && !smsIsConfigured()) {
        return { sent: false, reason: "sms_not_configured" };
      }
      renderedBody = reviewSmsBody(cfg, contact, businessName, bodyUrl);
      const res = await sendSmsForSubAccount({
        subAccountId: input.subAccountId,
        subAccount,
        to: contact.phone,
        body: renderedBody,
        origin,
      });
      sid = res.sid;
      fromNumber = res.from;
      // Thread row only in dedicated mode (shared-sender writes no thread).
      writeRow = res.mode === "dedicated";
    }

    // ---- Persist (message row + inbox + stamp + activity) ----
    if (writeRow) {
      try {
        await db
          .collection("contacts")
          .doc(contact.id)
          .collection(messagesCollection)
          .doc(sid)
          .set({
            agencyId: input.agencyId,
            subAccountId: input.subAccountId,
            contactId: contact.id,
            direction: "outbound",
            status: "sent",
            body: renderedBody,
            from: fromNumber,
            to: contact.phone,
            twilioMessageSid: sid,
            sentByUid: "review-request",
            error: null,
            readAt: null,
            createdAt: FieldValue.serverTimestamp(),
          });
      } catch (err) {
        console.warn("[reviews/request] message-row write failed", err);
      }
      await upsertConversationForMessage({
        contactId: contact.id,
        subAccountId: input.subAccountId,
        agencyId: input.agencyId,
        contactName: contact.name ?? "",
        contactPhone: contact.phone,
        channel: convoChannel,
        direction: "outbound",
        body: renderedBody,
      });
    }

    // Cooldown stamp.
    try {
      await db.doc(`contacts/${contact.id}`).set(
        {
          reviewRequestedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (err) {
      console.warn("[reviews/request] stamp write failed", err);
    }

    // Activity row.
    try {
      await db
        .collection("contacts")
        .doc(contact.id)
        .collection("activities")
        .add({
          type: "review_requested",
          content: `Google review requested via ${isWhatsapp ? "WhatsApp" : "SMS"}.`,
          createdBy: "review-request",
          meta: { sid, channel, trigger: input.trigger },
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn("[reviews/request] activity write failed", err);
    }

    // A reminder is an attempt on its request (the worker records it), not a new request.
    if (isReminder) return { sent: true };

    // The queryable request log (Reputation). Never throws.
    await logReviewRequest({
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      createdByUid: input.actorUid ?? "review-request",
      contactId: contact.id,
      channel: isWhatsapp ? "whatsapp" : "sms",
      source: "dispatcher",
      trigger: input.trigger,
      status: "sent",
      messageSid: sid,
      ...(extraListing ? { locationName: extraListing } : {}),
      // With a reminder: a hash of the number it went to (never the number), so a
      // reminder can stop if the contact's number changes.
      ...(plan
        ? {
            id: plan.requestId,
            tracked: plan.tracked,
            reminder: { ...plan.reminder },
            toHash: phoneHash(contact.phone),
            // A hash of the template used — never the body — so a reminder stops if it changes.
            templateHash: templateHash(cfg.messageTemplate || DEFAULT_REVIEW_SMS_TEMPLATE),
          }
        : {}),
    });
    if (input.expect) {
      // An approved send starts no reminders, and ends any still waiting.
      await supersedeOtherReminders(input.subAccountId, contact.id, phoneHash(contact.phone), "");
    }
    if (plan?.reminder) {
      await supersedeOtherReminders(input.subAccountId, contact.id, phoneHash(contact.phone), plan.requestId);
      await scheduleReviewReminder({
        subAccountId: input.subAccountId,
        requestId: plan.requestId,
        attempt: 1,
        everyDays: plan.reminder.everyDays,
      });
    }

    return { sent: true };
  } catch (err) {
    if (isQuietHoursDeferred(err)) {
      // Nothing went out. A reminder is rescheduled by its own worker (it owns
      // the attempt count); anything else is re-run whole at the window's end,
      // so opt-out, cooldown and every gate above are checked again then.
      if (input.trigger === "reminder") {
        return { sent: false, reason: "quiet_hours", quietHours: err.hold };
      }
      await holdForQuietHours({
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        payload: { kind: "review_request", request: input },
        hold: err.hold,
      });
      return { sent: false, reason: "quiet_hours_held" };
    }
    console.warn("[reviews/request] failed", err);
    return { sent: false, reason: "send_failed" };
  }
}

/**
 * When did this contact last message in? Null when their most recent thread
 * activity is not an inbound, which the shared send-mode rule reads as a shut
 * window.
 */
async function whatsappLastInboundAt(
  db: Firestore,
  contactId: string,
): Promise<Date | null> {
  try {
    const snap = await db
      .collection(`contacts/${contactId}/whatsappMessages`)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    for (const d of snap.docs) {
      const m = d.data() as {
        direction?: string;
        createdAt?: { toMillis?: () => number };
      };
      if (m.direction === "inbound") {
        const ms =
          m.createdAt && typeof m.createdAt.toMillis === "function"
            ? m.createdAt.toMillis()
            : null;
        return ms === null ? null : new Date(ms);
      }
    }
    return null;
  } catch {
    // A failed read degrades to "window shut", which forces a template or a
    // refusal. Erring open would send free-form into a window Meta considers
    // closed.
    return null;
  }
}
