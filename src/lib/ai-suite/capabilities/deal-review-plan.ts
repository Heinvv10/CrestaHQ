import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { resolveReviewUrl } from "@/lib/reviews/canonical-url";
import { activeReminder, DEFAULT_REVIEW_COOLDOWN_DAYS, normalizeReviewChannel } from "@/lib/reviews/constants";
import { fillPositional, reviewSmsBody, reviewTemplateFill } from "@/lib/reviews/review-body";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import type { PreviewRow } from "./types";
import { oneLine, messageBody } from "./text-safety";
import { masked } from "./conversation-send-support";
import { millis } from "@/lib/server/agent-proposals-encoding";

/**
 * What completing a Won deal would send: the Google review request
 * maybeSendReviewRequest makes for `deal_completed`, worked out from the
 * same stored config, contact and template (lib/reviews/review-body.ts), so
 * the approver reads the actual text. Shared by the preview and the
 * approve-time re-check.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReviewPlan {
  contactId: string | null;
  phone: string;
  /** The exact text, or null when nothing would be sent. */
  body: string | null;
  rows: PreviewRow[];
}

const none = (contactId: string | null, phone: string, why: string): ReviewPlan => ({
  contactId,
  phone,
  body: null,
  rows: [{ label: "Review request", value: `None: ${why}` }],
});

export async function reviewPlan(subAccountId: string, deal: FirebaseFirestore.DocumentData, nowMs: number): Promise<ReviewPlan> {
  const db = getAdminDb();
  const contactId = (deal.contactId as string | null) ?? null;
  const [contactSnap, sub] = await Promise.all([
    isDocId(contactId) ? db.doc(`contacts/${contactId}`).get() : null,
    db.doc(`subAccounts/${subAccountId}`).get().then((s) => s.data() as SubAccountDoc | undefined),
  ]);
  const data = contactSnap?.data();
  const contact = data && data.subAccountId === subAccountId ? ({ id: contactId, ...data } as Contact) : null;
  const phone = typeof contact?.phone === "string" ? contact.phone : "";
  const cfg = sub?.googleReviewConfig;
  const reviewUrl = resolveReviewUrl(sub).configured;
  if (!sub || !cfg?.enabled || cfg.triggerOnDealCompleted !== true || !reviewUrl) {
    return none(contactId, phone, "review requests for completed deals are off in this workspace.");
  }
  if (!contact || !phone) return none(contactId, phone, "the deal's contact has no phone number.");
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
  let body: string;
  if (channel === "whatsapp_template") {
    if (!cfg.whatsappTemplateId) return none(contactId, phone, "no WhatsApp review template is set.");
    const filled = await reviewTemplateFill(db, subAccountId, cfg.whatsappTemplateId, contact, sub);
    if (!filled.ok) return none(contactId, phone, `the WhatsApp review template can't be sent (${filled.reason}).`);
    body = fillPositional(filled.tpl.body, filled.values);
  } else {
    body = reviewSmsBody(cfg, contact, sub.name ?? "", reviewUrl);
  }
  // Shown exactly as sent; a stored template with hidden characters can't be.
  const shown = messageBody(body);
  if (shown === null) return none(contactId, phone, "the review request's text contains characters that can't be shown safely.");
  const tracked = channel === "sms" && activeReminder(cfg.reminder) ? " The link may go as a tracking link that forwards to it." : "";
  return {
    contactId,
    phone,
    body: shown,
    rows: [
      { label: "Review request", value: `Sent to ${oneLine(contact.name) || "(unnamed)"} (${masked("sms", phone)}) by ${label}; quiet hours delay it.${tracked}` },
      { label: "Message", value: shown, multiline: true },
    ],
  };
}
