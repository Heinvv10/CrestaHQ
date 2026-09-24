import { NextResponse } from "next/server";
import { checkWhatsappReadiness } from "@/lib/comms/whatsapp/readiness";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { dispatchWhatsappTemplateSend } from "@/lib/comms/whatsapp/template-dispatch";
import {
  sendWhatsappTemplateForSubAccount,
} from "@/lib/comms/twilio";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { UsageQuotaExceededError } from "@/lib/server/usage-meter";
import { providerAttempted } from "@/lib/comms/provider-attempt";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { resolveTemplateVariables } from "@/lib/comms/whatsapp/resolve-template-variables";
import { logInboxReviewAsk, type AskOutcome } from "@/lib/reviews/review-ask";
import type { MergeTagSubject } from "@/lib/automations/merge-tags";
import type { AgencyDoc, SubAccountDoc } from "@/types";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";

type Body = {
  contactId?: string;
  templateId?: string;
  /** position (string) -> value, for manual variables (and overrides). */
  manualValues?: Record<string, string>;
};

/**
 * Send an APPROVED WhatsApp template to a contact. This is the only compliant
 * way to message outside the 24-hour session window, so — unlike the freeform
 * /whatsapp/send route — there is no window guard here; a template send
 * re-opens the window.
 *
 * Resolves the template's positional variables from the contact's merge tags
 * (+ operator-supplied manual values), sends via Twilio's contentSid path,
 * and writes the rendered message into the WhatsApp thread.
 */

function renderPreview(body: string, values: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => {
    const idx = Number(n) - 1;
    return values[idx] ?? "";
  });
}

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
  const templateId = payload.templateId?.trim();
  if (!contactId || !templateId) {
    return NextResponse.json(
      { error: "contactId and templateId are required" },
      { status: 400 },
    );
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;
  if (!contact.phone) {
    return NextResponse.json(
      { error: "This contact has no phone number." },
      { status: 400 },
    );
  }
  if (contact.whatsappOptedOut) {
    return NextResponse.json(
      { error: "This contact has opted out of WhatsApp." },
      { status: 400 },
    );
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
    return NextResponse.json(
      { error: "WhatsApp is disabled for this sub-account by your agency." },
      { status: 403 },
    );
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
    return NextResponse.json({ error: readiness.error }, { status: 503 });
  }
  if (!tplSnap.exists) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
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
  for (const [k, v] of Object.entries(payload.manualValues ?? {})) {
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
    return NextResponse.json(
      {
        error: `Fill in "${variable?.label ?? `variable ${emptyAt + 1}`}" before sending.`,
      },
      { status: 400 },
    );
  }

  // Logged once the send settles: sent, refused by the rail, or failed.
  const logAsk = (outcome: AskOutcome | null) =>
    logInboxReviewAsk({ contact, channel: "whatsapp", parts: [], template: tpl, templateValues: values, actorUid: auth.uid, outcome });

  let sid: string;
  let fromNumber: string;
  try {
    let templateFrom = "";
    const result = await dispatchWhatsappTemplateSend({
      subAccountId: contact.subAccountId,
      subAccount,
      to: contact.phone,
      template: tpl,
      values,
      // An operator sending from the thread: never held for quiet hours.
      origin: "manual",
      sendViaTwilio: async (contentSid) => {
        const r = await sendWhatsappTemplateForSubAccount({
          subAccountId: contact.subAccountId,
          subAccount,
          to: contact.phone,
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
      return NextResponse.json(
        { error: result.error ?? "Only an approved template can be sent." },
        { status: 409 },
      );
    }
    sid = result.messageId ?? "";
    fromNumber = templateFrom;
  } catch (err) {
    await logAsk(providerAttempted(err) ? { ok: false, failureKind: "send_failed" } : null);
    if (err instanceof UsageQuotaExceededError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    const message =
      err instanceof Error ? err.message : "Failed to send WhatsApp template";
    return NextResponse.json({ error: message }, { status: 502 });
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
        createdBy: auth.uid,
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
        sentByUid: auth.uid,
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
    contactPhone: contact.phone,
    channel: "whatsapp",
    direction: "outbound",
    body: rendered || `[Template: ${tpl.displayName}]`,
    pauseBot: true,
  });
  await logAsk({ ok: true, messageSid: sid });

  return NextResponse.json({ ok: true, sid });
}
