import "server-only";

import { createHash } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { checkWhatsappReadiness } from "@/lib/comms/whatsapp/readiness";
import { isDocId } from "@/lib/server/doc-id";
import { prepareWhatsappTemplateSend, renderPreview, sendWhatsappTemplate } from "@/lib/server/whatsapp-template-send";
import type { ContactProspecting, SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";
import { enquiryVars } from "./enquiry";
import { SPEED_CHECK_TEMPLATE_NAME, missingTemplateReason, pickShopTemplate, templateProblem } from "./whatsapp-template";
import type { ChannelState, SendResult } from "./send";
import { recordProviderRef, stampSendStart } from "./store";

/**
 * The WhatsApp mystery shop (PR 5b) over the existing template rail — never a
 * hand-rolled Graph call: `prepareWhatsappTemplateSend` + `sendWhatsappTemplate`
 * (the composer's own service, which also writes the thread). It sends only
 * from a Cloud default sender, because the Cloud inbound webhook is where the
 * reply is timed, and only an approved two-variable template (see
 * whatsapp-template.ts): `{{1}}` the service, `{{2}}` the town.
 */

/** The sub-account's mystery-shop template (whatsapp-template.ts `pickShopTemplate`), or null. */
async function loadShopTemplate(subAccountId: string, sub: SubAccountDoc): Promise<WhatsappTemplateDoc | null> {
  const col = getAdminDb().collection(`subAccounts/${subAccountId}/whatsappTemplates`);
  const chosen = sub.prospectingMysteryShopTemplates?.whatsappTemplateId;
  if (chosen && !isDocId(chosen)) return null;
  const docs = chosen ? [await col.doc(chosen).get()] : (await col.where("name", "==", SPEED_CHECK_TEMPLATE_NAME).get()).docs;
  const templates = docs.filter((d) => d.exists).map((d) => ({ ...(d.data() as WhatsappTemplateDoc), id: d.id }));
  return pickShopTemplate(templates, chosen);
}

const no = (reason: string): ChannelState => ({ available: false, reason });

/** Can a WhatsApp mystery shop send for this sub-account now? The reason names what is missing, the template's status included. */
export async function whatsappState(subAccountId: string, sub: SubAccountDoc): Promise<ChannelState> {
  if (sub.whatsappEnabledByAgency !== true) return no("WhatsApp is disabled for this sub-account by your agency.");
  const ready = await checkWhatsappReadiness({ subAccountId, subAccount: sub });
  if (!ready.ready) return no("No WhatsApp sender is connected.");
  if (ready.provider !== "cloud") {
    return no("Mystery-shop WhatsApp needs a WhatsApp Cloud sender as the default: only its replies can be timed.");
  }
  const found = await loadShopTemplate(subAccountId, sub);
  if (!found) return no(missingTemplateReason(!!sub.prospectingMysteryShopTemplates?.whatsappTemplateId));
  const problem = templateProblem(found);
  return problem ? no(problem) : { available: true };
}

export interface WhatsappEnquiry {
  templateId: string;
  /** `{{1}}` the service, `{{2}}` the town — never empty (Meta refuses an empty parameter). */
  values: [string, string];
  /** The template body as the business will read it. */
  text: string;
  /** Of the template id and the text: the dialog echoes it, so what is sent is what was seen. */
  hash: string;
}

/** The enquiry as this contact would get it now, or null without a template. */
export async function whatsappEnquiryOf(
  subAccountId: string,
  contact: { city?: unknown; prospecting?: ContactProspecting | null },
  sub: SubAccountDoc,
): Promise<WhatsappEnquiry | null> {
  const found = await loadShopTemplate(subAccountId, sub);
  if (!found) return null;
  const vars = enquiryVars(contact, sub.name);
  const values: [string, string] = [vars.service, vars.town ?? "your area"];
  const text = renderPreview(found.body ?? "", values);
  return { templateId: found.id, values, text, hash: createHash("sha256").update(`${found.id}\n${text}`, "utf8").digest("hex") };
}

/**
 * Send the template to the confirmed target, timing the shop from just before
 * Meta is asked and recording Meta's message id on it before anything else. The contact is sent with its
 * phone set to that target — the contact's own number in E.164, exactly what
 * the route checked — so the number checked is the number sent to.
 * `failed` = definitely not sent (refused before Meta, or Meta's 4xx);
 * `uncertain` = Meta may have it (an ambiguous answer, a 502, no message id).
 */
export async function sendWhatsappShop(input: {
  shopId: string;
  target: string;
  contact: Contact;
  contactId: string;
  uid: string;
  enquiry: WhatsappEnquiry | null | undefined;
}): Promise<SendResult> {
  const { enquiry } = input;
  if (input.contact.whatsappOptedOut === true) {
    return { ok: false, kind: "refused", code: "opted_out", reason: "This contact has opted out of WhatsApp." };
  }
  if (!enquiry) return { ok: false, kind: "refused", code: "channel_unavailable", reason: "The WhatsApp template isn't available." };
  const contact = { ...input.contact, phone: input.target };
  const prepared = await prepareWhatsappTemplateSend(contact, enquiry.templateId, { "1": enquiry.values[0], "2": enquiry.values[1] });
  if (!prepared.ok) return { ok: false, kind: "refused", code: "channel_unavailable", reason: prepared.error };
  if (renderPreview(prepared.tpl.body, prepared.values) !== enquiry.text) {
    return { ok: false, kind: "refused", code: "enquiry_changed", reason: "The WhatsApp template changed — reopen the dialog." };
  }
  // Timed from before Meta is asked; the message id on the shop the moment Meta gives it.
  const started = await stampSendStart(input.shopId).catch((err) => {
    console.error("[prospecting/mystery-shop] send start not recorded", input.shopId, err);
    return null;
  });
  if (!started) return { ok: false, kind: "failed", reason: "The send could not be started." };
  const sent = await sendWhatsappTemplate({
    onAccepted: (sid) =>
      recordProviderRef(input.shopId, sid).then(
        () => undefined,
        (err) => console.error("[prospecting/mystery-shop] message id not recorded early", input.shopId, err),
      ),
    subAccount: prepared.subAccount,
    tpl: prepared.tpl,
    values: prepared.values,
    contactId: input.contactId,
    contact,
    templateId: enquiry.templateId,
    actorUid: input.uid,
  });
  if (sent.ok) {
    return sent.sid ? { ok: true, providerRef: sent.sid } : { ok: false, kind: "uncertain", providerRef: null, reason: "No message id came back." };
  }
  if (sent.attempted && sent.providerOutcome === "DEFINITELY_REJECTED") return { ok: false, kind: "failed", reason: sent.error };
  if (sent.attempted || sent.status === 502) return { ok: false, kind: "uncertain", providerRef: null, reason: sent.error };
  return { ok: false, kind: "failed", reason: sent.error };
}
