import {
  isTemplateApprovedFor,
  templateRegistration,
  type RegistrationBearingTemplate,
} from "@/lib/comms/whatsapp/template-registrations";
import type { WhatsappTemplateDoc, WhatsappTemplateStatus } from "@/types/whatsapp-templates";

/**
 * The WhatsApp mystery shop's template (Prospecting PR 5b, report section 12).
 * A business-initiated WhatsApp must be a Meta-approved template, so the
 * neutral enquiry is one: `{{1}}` = the service, `{{2}}` = the town. The
 * sub-account picks it in Prospecting settings
 * (`prospectingMysteryShopTemplates.whatsappTemplateId`); unset, it is the one
 * named SPEED_CHECK_TEMPLATE_NAME. It sends from the Cloud sender only (the
 * rail whose inbound webhook times the reply), so only its Cloud registration
 * counts. Pure: the settings card shows the same status and reason.
 */

export const SPEED_CHECK_TEMPLATE_NAME = "leadstack_speed_check";

export type ShopTemplateFields = Pick<WhatsappTemplateDoc, "name" | "body" | "variables"> & RegistrationBearingTemplate;

const placeholders = (body: string) => [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));

/** Declared variables are exactly positions 1 and 2, and the body uses exactly those. */
export function hasTwoVariables(tpl: Pick<WhatsappTemplateDoc, "body" | "variables">): boolean {
  const declared = (tpl.variables ?? []).map((v) => v.position).sort((a, b) => a - b);
  const used = new Set(placeholders(tpl.body ?? ""));
  return declared.join(",") === "1,2" && used.size === 2 && used.has(1) && used.has(2);
}

/** The template's state on the Cloud rail; never submitted there reads as draft. */
export function cloudTemplateStatus(tpl: RegistrationBearingTemplate): {
  status: WhatsappTemplateStatus;
  rejectionReason: string | null;
} {
  const reg = templateRegistration(tpl, "cloud");
  return { status: reg?.status ?? "draft", rejectionReason: reg?.rejectionReason ?? null };
}

/**
 * The mystery shop's template among `templates`: the one chosen in settings
 * (by id), else the one named SPEED_CHECK_TEMPLATE_NAME — a usable one first,
 * if there are several. The server and the settings card pick the same way.
 */
export function pickShopTemplate<T extends ShopTemplateFields & { id: string }>(
  templates: T[],
  chosenId: string | null | undefined,
): T | null {
  if (chosenId) return templates.find((t) => t.id === chosenId) ?? null;
  const named = templates.filter((t) => t.name === SPEED_CHECK_TEMPLATE_NAME);
  return named.find((t) => templateProblem(t) === null) ?? named[0] ?? null;
}

/** Why there is no template: the one chosen in settings is gone, or none has the default name. */
export function missingTemplateReason(chosen: boolean): string {
  return chosen
    ? "The WhatsApp template chosen in Prospecting settings no longer exists."
    : `The WhatsApp template ${SPEED_CHECK_TEMPLATE_NAME} doesn't exist yet: create it and submit it to Meta.`;
}

/** Why this template can't send a mystery shop from the Cloud sender, naming its status; null when it can. */
export function templateProblem(tpl: ShopTemplateFields): string | null {
  const n = `The WhatsApp template ${tpl.name}`;
  if (!isTemplateApprovedFor(tpl, "cloud")) {
    if (!templateRegistration(tpl, "cloud")) {
      return tpl.status === "approved"
        ? `${n} is approved on another WhatsApp account only, not on your Meta WhatsApp account.`
        : `${n} hasn't been submitted to Meta yet.`;
    }
    const { status, rejectionReason } = cloudTemplateStatus(tpl);
    switch (status) {
      case "pending":
      case "submitting":
        return `${n} is pending Meta approval.`;
      case "rejected":
        return `${n} was rejected: ${rejectionReason || "no reason given"}.`;
      case "failed":
        return `${n} could not be submitted to Meta: ${rejectionReason || "no reason given"}.`;
      case "paused":
      case "disabled":
        return `${n} is ${status} by Meta.`;
      case "draft":
        return `${n} hasn't been submitted to Meta yet.`;
      default:
        // Approved but without the Meta template id a send needs.
        return `${n} isn't approved on your Meta WhatsApp account.`;
    }
  }
  if (!hasTwoVariables(tpl)) return `${n} must have exactly two variables: {{1}} the service and {{2}} the town.`;
  return null;
}
