import "server-only";

import { createHash } from "node:crypto";
import { resolveWhatsappSender } from "./resolve-sender";
import { templateRegistration } from "./template-registrations";
import type { SubAccountDoc } from "@/types";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";

/**
 * One hash of what a template send puts in front of the contact: the
 * template, the rail it goes out on, that rail's own copy (its id), and the
 * filled-in values. What a person approved must still hash the same when it
 * is sent (send_whatsapp_template, and the approved review request).
 */
export function templateFingerprint(templateId: string, subAccount: SubAccountDoc, tpl: WhatsappTemplateDoc, values: string[]): string {
  const sender = resolveWhatsappSender(subAccount);
  const provider = sender.ok ? sender.provider : null;
  const externalId = provider ? (templateRegistration(tpl, provider)?.externalId ?? null) : null;
  return createHash("sha256")
    .update(JSON.stringify([templateId, provider, externalId, tpl.name, tpl.language, tpl.body, tpl.buttons ?? [], values]))
    .digest("hex");
}

/** The template's buttons as an approver reads them, or null. */
export function describeTemplateButtons(tpl: WhatsappTemplateDoc): string | null {
  if (!tpl.buttons?.length) return null;
  return tpl.buttons.map((b) => (b.type === "url" ? `link "${b.text}" (${b.url})` : `quick reply "${b.text}"`)).join(" · ");
}
