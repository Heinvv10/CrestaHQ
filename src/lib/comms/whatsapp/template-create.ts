import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sanitiseButtons, sanitiseVariables } from "./template-validation";
import { loadContactCustomFieldKeys } from "@/lib/custom-fields/load-defs";
import type { SubAccountDoc } from "@/types";
import type { WhatsappTemplateCategory } from "@/types/whatsapp-templates";

/**
 * Creating a DRAFT WhatsApp template — shared by the create route (POST
 * whatsapp-templates) and the agent's create_whatsapp_template, so the two
 * validate and store a template identically. A draft reaches nobody:
 * submitting it for Meta approval is template-submit.ts. Creating one needs
 * the agency WhatsApp gate, not a configured sender (you can draft before
 * connecting).
 */

const VALID_CATEGORIES: WhatsappTemplateCategory[] = [
  "UTILITY",
  "MARKETING",
  "AUTHENTICATION",
];

export interface TemplateDraftInput {
  displayName?: string;
  category?: string;
  language?: string;
  body?: string;
  variables?: unknown;
  buttons?: unknown;
}

/** A refusal and the HTTP status the route answers it with. */
export interface TemplateRefusal {
  ok: false;
  status: number;
  error: string;
}

export async function createWhatsappTemplateDraft(opts: {
  subAccountId: string;
  input: TemplateDraftInput;
  createdByUid: string;
  /** Extra fields for the new doc (an API agent's edit stamp). */
  stamp?: Record<string, unknown>;
}): Promise<{ ok: true; id: string } | TemplateRefusal> {
  const { subAccountId, input } = opts;
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const sub = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
  if (sub?.whatsappEnabledByAgency !== true) {
    return { ok: false, status: 403, error: "WhatsApp is disabled for this sub-account by your agency." };
  }

  const displayName = input.displayName?.trim() ?? "";
  const templateBody = input.body?.trim() ?? "";
  const category = (input.category ?? "").toUpperCase() as WhatsappTemplateCategory;
  const language = (input.language?.trim() || "en").slice(0, 12);

  if (!displayName) return { ok: false, status: 400, error: "displayName is required" };
  if (!templateBody) return { ok: false, status: 400, error: "body is required" };
  if (!VALID_CATEGORIES.includes(category)) {
    return { ok: false, status: 400, error: "category must be UTILITY, MARKETING, or AUTHENTICATION" };
  }
  const sanitised = sanitiseVariables(
    input.variables ?? [],
    templateBody,
    await loadContactCustomFieldKeys(subAccountId),
  );
  if ("error" in sanitised) return { ok: false, status: 400, error: sanitised.error };
  const buttons = sanitiseButtons(input.buttons, category);
  if ("error" in buttons) return { ok: false, status: 400, error: buttons.error };

  const ref = db.collection(`subAccounts/${subAccountId}/whatsappTemplates`).doc();
  await ref.set({
    subAccountId,
    agencyId: sub.agencyId,
    name: "",
    displayName: displayName.slice(0, 120),
    category,
    language,
    body: templateBody.slice(0, 1024),
    variables: sanitised.variables,
    buttons: buttons.buttons,
    contentSid: null,
    status: "draft",
    rejectionReason: null,
    pollAttempts: 0,
    lastSyncedAt: null,
    createdByUid: opts.createdByUid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    approvedAt: null,
    ...opts.stamp,
  });
  return { ok: true, id: ref.id };
}
