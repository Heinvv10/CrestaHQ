import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  contactFormFields,
  contactFormSettings,
  defaultFormFields,
  defaultFormSettings,
  type FormTemplate,
  type LeadForm,
} from "@/types/forms";

/**
 * Server-side twin of the client form helpers (`lib/firestore/forms.ts`),
 * for the AI Suite capabilities: list, read and create forms through the
 * Admin SDK with the same document shape the Forms page writes. The presets
 * (`contactFormFields` etc.) are the SAME functions the UI uses, so a form
 * created from chat is identical to one created by clicking "Contact form"
 * on the Forms page.
 */

export class FormServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "FormServiceError";
  }
}

const FORMS = "forms";

/** Same as the client helper's slugify. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "form"
  );
}

function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
}

/** Public hosted page for a form — the link the Forms page copies. */
export function formPublicUrl(formId: string): string {
  return `${appBaseUrl()}/f/${formId}`;
}

/** The form editor's "Copy iframe embed" snippet, minus the theme / accent
 *  params: the public page falls back to the form's saved appearance. */
export function formEmbedSnippet(formId: string): string {
  return `<iframe src="${appBaseUrl()}/f/${formId}?embed=1" width="100%" height="600" style="border:0;background:transparent" allowtransparency="true"></iframe>`;
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toMillis?: () => number; seconds?: number };
  if (typeof maybe.toMillis === "function") return maybe.toMillis();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}

/** Every form in the sub-account, newest first. */
export async function listFormsForSubAccount(
  subAccountId: string,
): Promise<LeadForm[]> {
  const snap = await getAdminDb()
    .collection(FORMS)
    .where("subAccountId", "==", subAccountId)
    .get();
  const forms = snap.docs.map(
    (d) => ({ id: d.id, ...(d.data() as Omit<LeadForm, "id">) }) as LeadForm,
  );
  forms.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
  return forms;
}

/** One form, only if it belongs to this sub-account (tenancy re-anchor). */
export async function getFormForSubAccount(
  subAccountId: string,
  formId: string,
): Promise<LeadForm | null> {
  const snap = await getAdminDb().doc(`${FORMS}/${formId}`).get();
  if (!snap.exists) return null;
  const data = snap.data() as Omit<LeadForm, "id">;
  if (data.subAccountId !== subAccountId) return null;
  return { id: snap.id, ...data };
}

/**
 * Create a form from a preset: the same fields, settings and tenancy keys as
 * `createForm` in the client helpers, via the Admin SDK. The agencyId comes
 * from the sub-account doc, never from the caller.
 */
export async function createFormServerSide(opts: {
  subAccountId: string;
  createdByUid: string;
  name: string;
  template?: FormTemplate;
}): Promise<string> {
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${opts.subAccountId}`).get();
  if (!subSnap.exists) throw new FormServiceError("Sub-account not found", 404);
  const agencyId = (subSnap.data()?.agencyId as string | undefined) ?? "";
  if (!agencyId) {
    throw new FormServiceError("Sub-account is missing agencyId.", 500);
  }
  const name = opts.name.trim();
  if (!name) throw new FormServiceError("A form name is required.");

  const template: FormTemplate = opts.template ?? "blank";
  const fields =
    template === "contact" ? contactFormFields() : defaultFormFields();
  const settings =
    template === "contact" ? contactFormSettings() : defaultFormSettings();

  const ref = db.collection(FORMS).doc();
  await ref.set({
    name,
    slug: slugify(name),
    fields,
    settings,
    agencyId,
    subAccountId: opts.subAccountId,
    createdByUid: opts.createdByUid,
    enabled: true,
    submissionCount: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}
