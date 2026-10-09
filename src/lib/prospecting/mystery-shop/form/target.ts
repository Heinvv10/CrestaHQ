import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { normalizePhoneE164 } from "@/lib/contacts/phone";
import type { SubAccountDoc } from "@/types";
import { normalizeEmailTarget, normalizeFormUrl } from "../targets";
import type { ChannelState } from "../send";
import { formEngineAvailable } from "./browser";
import type { FormIdentity } from "./mapping";

/**
 * Where a form shop may go, and as whom.
 *
 * The ONLY allowed form target is the contact's latest ready report's
 * lead-capture `formUrl` (`prospecting.lastReportId`, stamped at ready),
 * normalised; the POST's target must equal it exactly. A report from before
 * lead capture recorded it has no `formUrl` key: the channel is then
 * unavailable until a new report is generated.
 */

export const NEW_REPORT = "Generate a new report to find the website's contact form.";
export const NO_FORM = "No contact form was found on this business's website.";

/** `url` = the allowed target; else `reason` says why the channel is unavailable (null: the site has no form). */
export async function formTargetOf(
  subAccountId: string,
  contact: { id: string; prospecting?: { lastReportId?: string | null } | null },
): Promise<{ url: string; reason: null } | { url: null; reason: string | null }> {
  const reportId = contact.prospecting?.lastReportId;
  if (typeof reportId !== "string" || !reportId || reportId.includes("/")) return { url: null, reason: NEW_REPORT };
  const report = (await getAdminDb().doc(`prospectReports/${reportId}`).get()).data();
  if (report?.subAccountId !== subAccountId || report.contactId !== contact.id || report.status !== "ready") {
    return { url: null, reason: NEW_REPORT };
  }
  const sections = Array.isArray(report.sections) ? (report.sections as { key?: unknown; raw?: Record<string, unknown> }[]) : [];
  const raw = sections.find((s) => s?.key === "lead_capture")?.raw;
  // A report from before lead capture recorded formUrl has no such key: undefined, so a new report is asked for.
  if (raw?.formUrl === null) return { url: null, reason: null };
  const url = normalizeFormUrl(raw?.formUrl);
  return url ? { url, reason: null } : { url: null, reason: NEW_REPORT };
}

/** The synced mailbox's address: what the form is filled with, so the reply lands where it is read. */
const mailboxAddress = (sub: SubAccountDoc) => normalizeEmailTarget(sub.mailboxConfig?.username);

/**
 * The form channel needs a working synced mailbox (its address goes in the
 * form and the reply is timed from it) and the engine's Chromium on disk.
 * No SMTP: nothing is emailed.
 */
export function formChannelState(sub: SubAccountDoc): ChannelState {
  const mailbox = sub.mailboxConfig;
  if (!mailbox?.enabled || !mailbox.verifiedAt) {
    return { available: false, reason: "Connect your IMAP mailbox in Messaging settings first, so replies can be timed." };
  }
  if (mailbox.lastError) return { available: false, reason: `The mailbox sync is failing: ${mailbox.lastError}` };
  if (!mailboxAddress(sub)) return { available: false, reason: "The mailbox address isn't known." };
  if (!formEngineAvailable()) return { available: false, reason: "The form engine isn't installed on this server." };
  return { available: true };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/**
 * The sub-account's real identity as the form gets it: its name, the synced
 * mailbox address and its WhatsApp number in E.164 — the Cloud sender's
 * (whose replies the Cloud webhook matches), else Branding's. Calls to that
 * number are not matched; the card says so. Null without a mailbox address.
 */
export function formIdentity(
  sub: SubAccountDoc,
  enquiry: { subject: string; message: string; service: string },
): FormIdentity | null {
  const email = mailboxAddress(sub);
  if (!email) return null;
  const country = str(sub.defaultPhoneCountry);
  // The Cloud sender's number first: its WhatsApp replies reach the Cloud webhook, where they are matched.
  const phone =
    normalizePhoneE164(str(sub.whatsappCloudMeta?.displayPhoneNumber), country) ??
    normalizePhoneE164(str(sub.whatsappNumber), country);
  return { business: sub.name, email, phone, ...enquiry };
}
