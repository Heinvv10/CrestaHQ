import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { resolveReviewUrl } from "@/lib/reviews/canonical-url";
import { activeReminder, DEFAULT_REVIEW_COOLDOWN_DAYS, normalizeReviewChannel, type ReviewChannel } from "@/lib/reviews/constants";
import { reviewBodyNow } from "@/lib/reviews/review-body";
import { describeTemplateButtons } from "@/lib/comms/whatsapp/template-fingerprint";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import type { PreviewRow } from "./types";
import { oneLine, messageBody } from "./text-safety";
import { masked } from "./conversation-send-support";
import { millis } from "@/lib/server/agent-proposals-encoding";

/**
 * What completing a Won deal (or marking a quote paid) would send: the
 * Google review request maybeSendReviewRequest makes for `deal_completed`
 * (`quote_paid`), worked out from the same stored config, contact and
 * template (lib/reviews/review-body.ts), so the approver reads the actual
 * text. Shared by the previews and the approve-time re-checks.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReviewPlan {
  contactId: string | null;
  phone: string;
  /** The exact text (raw, as the send renders it), or null when nothing would be sent. */
  body: string | null;
  /** The configured channel the text goes on (null when nothing is sent). */
  channel: ReviewChannel | null;
  /** whatsapp_template only: templateFingerprint of what would be sent. */
  fingerprint: string | null;
  rows: PreviewRow[];
}

const none = (contactId: string | null, phone: string, why: string): ReviewPlan => ({
  contactId,
  phone,
  body: null,
  channel: null,
  fingerprint: null,
  rows: [{ label: "Review request", value: `None: ${why}` }],
});

export async function reviewPlan(
  subAccountId: string,
  record: FirebaseFirestore.DocumentData,
  nowMs: number,
  trigger: "deal_completed" | "quote_paid" = "deal_completed"
): Promise<ReviewPlan> {
  const db = getAdminDb();
  const contactId = (record.contactId as string | null) ?? null;
  const [contactSnap, sub] = await Promise.all([
    isDocId(contactId) ? db.doc(`contacts/${contactId}`).get() : null,
    db.doc(`subAccounts/${subAccountId}`).get().then((s) => s.data() as SubAccountDoc | undefined),
  ]);
  const data = contactSnap?.data();
  const contact = data && data.subAccountId === subAccountId ? ({ id: contactId, ...data } as Contact) : null;
  const phone = typeof contact?.phone === "string" ? contact.phone : "";
  const cfg = sub?.googleReviewConfig;
  const reviewUrl = resolveReviewUrl(sub).configured;
  const quote = trigger === "quote_paid";
  if (!sub || !cfg?.enabled || (quote ? cfg.triggerOnQuotePaid : cfg.triggerOnDealCompleted) !== true || !reviewUrl) {
    return none(contactId, phone, `review requests for ${quote ? "paid quotes" : "completed deals"} are off in this workspace.`);
  }
  if (!contact || !phone) return none(contactId, phone, `the ${quote ? "quote" : "deal"}'s contact has no phone number.`);
  const channel = normalizeReviewChannel(cfg.channel);
  const label = channel === "sms" ? "SMS" : "WhatsApp";
  if (channel === "sms" ? smsSendBlock(contact) : contact.whatsappOptedOut) {
    return none(contactId, phone, `the contact has opted out of ${label}.`);
  }
  const cooldownDays = cfg.cooldownDays > 0 ? cfg.cooldownDays : DEFAULT_REVIEW_COOLDOWN_DAYS;
  const last = millis(contact.reviewRequestedAt);
  if (last && nowMs - last < cooldownDays * DAY_MS) {
    return none(contactId, phone, `the contact was asked for a review in the last ${cooldownDays} days.`);
  }
  const now = await reviewBodyNow({ db, subAccountId, subAccount: sub, cfg, channel, contact, reviewUrl });
  if (!now.ok) return none(contactId, phone, now.why);
  // Shown byte for byte as sent (and pinned so): hidden characters, or
  // spacing a message body would tidy, can't be shown exactly.
  const shown = messageBody(now.body);
  const buttons = now.template ? describeTemplateButtons(now.template.tpl) : null;
  if (shown === null) return none(contactId, phone, "the review request's text contains characters that can't be shown safely.");
  if (shown !== now.body) return none(contactId, phone, "the review request's text has spacing that can't be shown exactly as sent.");
  return {
    contactId,
    phone,
    body: now.body,
    channel,
    fingerprint: now.template?.fingerprint ?? null,
    rows: [
      { label: "Review request", value: `Sent to ${oneLine(contact.name) || "(unnamed)"} (${masked("sms", phone)}) by ${label}; quiet hours delay it.` },
      ...(now.template
        ? [
            { label: "Template", value: `${oneLine(now.template.tpl.displayName) || "(unnamed)"} (${oneLine(now.template.tpl.name)})` },
            { label: "Language", value: oneLine(now.template.tpl.language) },
          ]
        : []),
      { label: "Message", value: shown, multiline: true },
      ...(buttons ? [{ label: "Buttons", value: buttons }] : []),
      // The send skips reminders for an approved request (see `expect`).
      ...(activeReminder(cfg.reminder)
        ? [{ label: "Reminders", value: "No reminders will follow (reminders apply only to requests people send)." }]
        : []),
    ],
  };
}
