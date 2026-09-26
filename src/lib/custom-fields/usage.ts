import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Stored text that names a custom field by its key (`customFields.<key>`,
 * the form conditions and merge tags use): workflows (triggers, conditions,
 * step text), WhatsApp templates (variable merge tags) and snippets. After a
 * delete, those read the field as empty. Other text (email templates,
 * broadcasts) is not scanned.
 */
export async function customFieldUsage(
  subAccountId: string,
  key: string,
): Promise<{ workflows: number; whatsappTemplates: number; snippets: number }> {
  const db = getAdminDb();
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = new RegExp(`customFields\\.${escaped}(?![A-Za-z0-9_])`);
  const [workflows, templates, snippets] = await Promise.all([
    db.collection("workflows").where("subAccountId", "==", subAccountId).get(),
    db.collection(`subAccounts/${subAccountId}/whatsappTemplates`).get(),
    db.collection("snippets").where("subAccountId", "==", subAccountId).get(),
  ]);
  const count = (docs: FirebaseFirestore.QueryDocumentSnapshot[]) =>
    docs.filter((d) => names.test(JSON.stringify(d.data()))).length;
  return { workflows: count(workflows.docs), whatsappTemplates: count(templates.docs), snippets: count(snippets.docs) };
}
