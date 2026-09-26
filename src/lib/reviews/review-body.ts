import "server-only";

import type { Firestore } from "firebase-admin/firestore";
import { resolveTemplateVariables } from "@/lib/comms/whatsapp/resolve-template-variables";
import { DEFAULT_REVIEW_SMS_TEMPLATE, type ReviewChannel } from "@/lib/reviews/constants";
import type { MergeTagSubject } from "@/lib/automations/merge-tags";
import type { AgencyDoc, SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import type { GoogleReviewConfig } from "@/types";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";

/**
 * What a review request says, built one way for the send
 * (maybeSendReviewRequest) and for anything that must show it first (the
 * agent's mark_deal_completed preview).
 */

function firstWord(s: string): string {
  const t = (s ?? "").trim();
  const i = t.indexOf(" ");
  return i === -1 ? t : t.slice(0, i);
}

function fillReviewSms(
  template: string,
  v: { firstName: string; businessName: string; reviewUrl: string },
): string {
  return template
    .replace(/\{\{\s*firstName\s*\}\}/g, v.firstName)
    .replace(/\{\{\s*businessName\s*\}\}/g, v.businessName)
    .replace(/\{\{\s*reviewUrl\s*\}\}/g, v.reviewUrl);
}

export function fillPositional(body: string, values: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => values[Number(n) - 1] ?? "");
}

/** The SMS / free-form WhatsApp text. */
export function reviewSmsBody(
  cfg: Pick<GoogleReviewConfig, "messageTemplate">,
  contact: Pick<Contact, "name">,
  businessName: string,
  reviewUrl: string,
): string {
  return fillReviewSms(cfg.messageTemplate || DEFAULT_REVIEW_SMS_TEMPLATE, {
    firstName: firstWord(contact.name),
    businessName,
    reviewUrl,
  });
}

/** The WhatsApp template and its variable values, as the template send fills it. */
export async function reviewTemplateFill(
  db: Firestore,
  subAccountId: string,
  templateId: string,
  contact: Contact,
  subAccount: SubAccountDoc,
): Promise<{ ok: true; tpl: WhatsappTemplateDoc; values: string[] } | { ok: false; reason: "template_not_approved" | "template_var_missing" }> {
  const tplSnap = await db.doc(`subAccounts/${subAccountId}/whatsappTemplates/${templateId}`).get();
  const tpl = tplSnap.exists ? (tplSnap.data() as WhatsappTemplateDoc) : null;
  if (!tpl) return { ok: false, reason: "template_not_approved" };
  const subject = await buildSubject(db, contact, subAccount);
  const values = resolveTemplateVariables({
    variables: tpl.variables,
    subject,
    manualValues: {},
  });
  if (values.some((v) => v.trim() === "")) {
    return { ok: false, reason: "template_var_missing" };
  }
  return { ok: true, tpl, values };
}

/**
 * The text a review request would carry right now on `channel`, with the
 * configured review link (before any per-request tracking-link swap): what
 * an approver is shown, and what an approved send must still be.
 */
export async function reviewBodyNow(opts: {
  db: Firestore;
  subAccountId: string;
  subAccount: SubAccountDoc;
  cfg: GoogleReviewConfig;
  channel: ReviewChannel;
  contact: Contact;
  reviewUrl: string;
}): Promise<{ ok: true; body: string } | { ok: false; why: string }> {
  const { cfg, contact } = opts;
  if (opts.channel !== "whatsapp_template") {
    return { ok: true, body: reviewSmsBody(cfg, contact, opts.subAccount.name ?? "", opts.reviewUrl) };
  }
  if (!cfg.whatsappTemplateId) return { ok: false, why: "no WhatsApp review template is set." };
  const filled = await reviewTemplateFill(opts.db, opts.subAccountId, cfg.whatsappTemplateId, contact, opts.subAccount);
  if (!filled.ok) return { ok: false, why: `the WhatsApp review template can't be sent (${filled.reason}).` };
  return { ok: true, body: fillPositional(filled.tpl.body, filled.values) };
}

/** Build the merge-tag subject for WhatsApp template variable resolution. */
async function buildSubject(
  db: Firestore,
  contact: Contact,
  subAccount: SubAccountDoc,
): Promise<MergeTagSubject> {
  let owner = { displayName: "", email: "" };
  try {
    const agencySnap = await db.doc(`agencies/${contact.agencyId}`).get();
    const agency = agencySnap.exists ? (agencySnap.data() as AgencyDoc) : null;
    if (agency?.ownerUid) {
      const ownerSnap = await db.doc(`users/${agency.ownerUid}`).get();
      const od = ownerSnap.data();
      owner = {
        displayName: (od?.displayName as string) ?? "",
        email: (od?.email as string) ?? "",
      };
    }
  } catch {
    /* best-effort */
  }
  return {
    contact: {
      name: contact.name ?? "",
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      customFields: contact.customFields ?? null,
    },
    owner,
    workspace: { name: subAccount.name ?? "" },
    bookingLink: subAccount.bookingLink ?? "",
    unsubscribeLink: "",
  };
}
