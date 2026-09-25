import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { checkWhatsappReadiness } from "@/lib/comms/whatsapp/readiness";
import { getAdminDb } from "@/lib/firebase/admin";
import { dispatchWhatsappTemplateSend } from "@/lib/comms/whatsapp/template-dispatch";
import {
  sendWhatsappTemplateForSubAccount,
} from "@/lib/comms/twilio";
import { UsageQuotaExceededError } from "@/lib/server/usage-meter";
import { providerAttempted } from "@/lib/comms/provider-attempt";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { resolveTemplateVariables } from "@/lib/comms/whatsapp/resolve-template-variables";
import { logInboxReviewAsk, type AskOutcome } from "@/lib/reviews/review-ask";
import type { MergeTagSubject } from "@/lib/automations/merge-tags";
import type { AgencyDoc, SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";

/**
 * Send an APPROVED WhatsApp template to a contact. This is the only compliant
 * way to message outside the 24-hour session window, so — unlike the freeform
 * /whatsapp/send route — there is no window guard here; a template send
 * re-opens the window.
 *
 * Resolves the template's positional variables from the contact's merge tags
 * (+ operator-supplied manual values), sends via Twilio's contentSid path,
 * and writes the rendered message into the WhatsApp thread.
 *
 * Shared by /api/comms/whatsapp/send-template (the composer) and the agent
 * send_whatsapp_template capability. Callers resolve the contact through
 * requireContactAccessible (or its equivalent) first.
 */

/** A refusal, carrying the HTTP status the composer's route answers with. */
export type TemplateSendRefusal = { ok: false; status: number; error: string };

export type PreparedTemplateSend = {
  subAccount: SubAccountDoc;
  tpl: WhatsappTemplateDoc;
  values: string[];
};

export function renderPreview(body: string, values: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => {
    const idx = Number(n) - 1;
    return values[idx] ?? "";
  });
}

/**
 * Everything decided before the send: the contact can receive it, WhatsApp
 * is on and ready for the sub-account, the template exists, and every
 * variable has a value.
 */
export async function prepareWhatsappTemplateSend(
  contact: Contact,
  templateId: string,
  rawManualValues: Record<string, string> | undefined,
): Promise<({ ok: true } & PreparedTemplateSend) | TemplateSendRefusal> {
  if (!contact.phone) {
    return { ok: false, status: 400, error: "This contact has no phone number." };
  }
  if (contact.whatsappOptedOut) {
    return { ok: false, status: 400, error: "This contact has opted out of WhatsApp." };
  }

  const db = getAdminDb();
  const [subSnap, tplSnap] = await Promise.all([
    db.doc(`subAccounts/${contact.subAccountId}`).get(),
    db
      .doc(`subAccounts/${contact.subAccountId}/whatsappTemplates/${templateId}`)
      .get(),
  ]);
  const subAccount = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;

  if (subAccount?.whatsappEnabledByAgency !== true) {
    return { ok: false, status: 403, error: "WhatsApp is disabled for this sub-account by your agency." };
  }
  // Per-rail, not Twilio-only. dispatchWhatsappTemplateSend below already
  // supports Cloud and refuses the bridge with its own message, but this gate
  // ran first and demanded Twilio credentials — so a correctly connected Cloud
  // workspace could never reach the dispatcher that supports it. Asking a
  // Cloud workspace for a Twilio number is not a stricter check, it is the
  // wrong one.
  const readiness = await checkWhatsappReadiness({
    subAccountId: contact.subAccountId,
    subAccount,
  });
  if (!readiness.ready) {
    return { ok: false, status: 503, error: readiness.error };
  }
  if (!tplSnap.exists) {
    return { ok: false, status: 404, error: "Template not found" };
  }
  const tpl = tplSnap.data() as WhatsappTemplateDoc;
  // Per-rail approval is checked inside the dispatcher, which knows which rail
  // this workspace sends on and can say which one the template is missing on.

  // Build the merge-tag subject (owner snapshot from the agency owner).
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
    /* best-effort — empty owner is tolerated by the resolver */
  }

  const subject: MergeTagSubject = {
    contact: {
      name: contact.name ?? "",
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      customFields: contact.customFields ?? null,
    },
    owner,
    workspace: { name: subAccount?.name ?? "" },
    bookingLink: subAccount?.bookingLink ?? "",
    unsubscribeLink: "",
  };

  // Coerce manual values to a position-keyed numeric map.
  const manualValues: Record<number, string> = {};
  for (const [k, v] of Object.entries(rawManualValues ?? {})) {
    const pos = Number(k);
    if (Number.isInteger(pos) && typeof v === "string") manualValues[pos] = v;
  }

  const values = resolveTemplateVariables({
    variables: tpl.variables,
    subject,
    manualValues,
  });

  // Twilio rejects empty content variables — every slot must have a value.
  const emptyAt = values.findIndex((v) => v.trim() === "");
  if (emptyAt !== -1) {
    const variable = tpl.variables[emptyAt];
    return {
      ok: false,
      status: 400,
      error: `Fill in "${variable?.label ?? `variable ${emptyAt + 1}`}" before sending.`,
    };
  }

  return { ok: true, subAccount, tpl, values };
}

/** Send a prepared template, then write the thread, activity and inbox rows. */
export async function sendWhatsappTemplate(input: PreparedTemplateSend & {
  contactId: string;
  contact: Contact;
  templateId: string;
  actorUid: string;
}): Promise<{ ok: true; sid: string } | TemplateSendRefusal> {
  const { contactId, contact, templateId, subAccount, tpl, values, actorUid } = input;
  const db = getAdminDb();

  // Logged once the send settles: sent, refused by the rail, or failed.
  const logAsk = (outcome: AskOutcome | null) =>
    logInboxReviewAsk({ contact, channel: "whatsapp", parts: [], template: tpl, templateValues: values, actorUid, outcome });

  let sid: string;
  let fromNumber: string;
  try {
    let templateFrom = "";
    const result = await dispatchWhatsappTemplateSend({
      subAccountId: contact.subAccountId,
      subAccount,
      to: contact.phone!,
      template: tpl,
      values,
      // An operator sending from the thread: never held for quiet hours.
      origin: "manual",
      sendViaTwilio: async (contentSid) => {
        const r = await sendWhatsappTemplateForSubAccount({
          subAccountId: contact.subAccountId,
          subAccount,
          to: contact.phone!,
          contentSid,
          contentVariables: values,
        });
        templateFrom = r.from;
        return { ok: true, messageId: r.sid };
      },
    });
    if (!result.ok) {
      // Only a provider's rejection is a failed ask; "not approved on this rail" never left.
      await logAsk(result.attempted && !result.refusedBy ? { ok: false, failureKind: result.error ?? "send_failed" } : null);
      return { ok: false, status: 409, error: result.error ?? "Only an approved template can be sent." };
    }
    sid = result.messageId ?? "";
    fromNumber = templateFrom;
  } catch (err) {
    await logAsk(providerAttempted(err) ? { ok: false, failureKind: "send_failed" } : null);
    if (err instanceof UsageQuotaExceededError) {
      return { ok: false, status: 429, error: err.message };
    }
    const message =
      err instanceof Error ? err.message : "Failed to send WhatsApp template";
    return { ok: false, status: 502, error: message };
  }

  const rendered = renderPreview(tpl.body, values);
  const preview = rendered.length > 80 ? `${rendered.slice(0, 80)}…` : rendered;

  try {
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type: "whatsapp_sent",
        content: `WhatsApp template (${tpl.displayName}): ${preview}`,
        createdBy: actorUid,
        meta: { sid, templateId, kind: "template" },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[whatsapp/send-template] activity write failed", err);
  }

  try {
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("whatsappMessages")
      .doc(sid)
      .set({
        agencyId: contact.agencyId,
        subAccountId: contact.subAccountId,
        contactId,
        direction: "outbound",
        status: "sent",
        body: rendered,
        from: fromNumber,
        to: contact.phone,
        twilioMessageSid: sid,
        sentByUid: actorUid,
        error: null,
        readAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[whatsapp/send-template] message-row write failed", err);
  }

  // Unified-inbox index, exactly as the free-form route does it: the thread
  // is now answered (leaves awaiting-reply), the preview is what was sent,
  // and the bot pauses so AI does not auto-reply over the operator. Runs only
  // after a successful send; upsertConversationForMessage never throws.
  await upsertConversationForMessage({
    contactId,
    subAccountId: contact.subAccountId,
    agencyId: contact.agencyId,
    contactName: contact.name ?? "",
    contactPhone: contact.phone!,
    channel: "whatsapp",
    direction: "outbound",
    body: rendered || `[Template: ${tpl.displayName}]`,
    pauseBot: true,
  });
  await logAsk({ ok: true, messageSid: sid });

  return { ok: true, sid };
}
