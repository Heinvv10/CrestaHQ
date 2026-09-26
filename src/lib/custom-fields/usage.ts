import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Stored config in this workspace that names a custom field by its key
 * (`customFields.<key>`, the form conditions and merge tags use): workflows
 * (triggers, conditions, step text, update_field), email / SMS templates
 * (which broadcasts send), WhatsApp templates, snippets, smart lists, and
 * the workspace's own settings
 * (e.g. the missed-call text-back). Deleting the definition doesn't stop
 * those: they keep reading and writing the stored values, which the app can
 * then no longer show or edit. A broadcast's audience filter can't name a
 * field (all / tag / pipeline stage only). `notChecked` names what this
 * can't see.
 */
export async function customFieldUsage(
  subAccountId: string,
  key: string,
): Promise<{
  workflows: number;
  messageTemplates: number;
  whatsappTemplates: number;
  snippets: number;
  smartLists: number;
  workspaceSettings: boolean;
  notChecked: string;
}> {
  const db = getAdminDb();
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = new RegExp(`customFields\\.${escaped}(?![A-Za-z0-9_])`);
  const [workflows, messageTemplates, templates, snippets, smartLists, sub] = await Promise.all([
    db.collection("workflows").where("subAccountId", "==", subAccountId).get(),
    db.collection("message_templates").where("subAccountId", "==", subAccountId).get(),
    db.collection(`subAccounts/${subAccountId}/whatsappTemplates`).get(),
    db.collection("snippets").where("subAccountId", "==", subAccountId).get(),
    db.collection(`subAccounts/${subAccountId}/smartLists`).get(),
    db.doc(`subAccounts/${subAccountId}`).get(),
  ]);
  const count = (docs: FirebaseFirestore.QueryDocumentSnapshot[]) =>
    docs.filter((d) => names.test(JSON.stringify(d.data()))).length;
  return {
    workflows: count(workflows.docs),
    messageTemplates: count(messageTemplates.docs),
    whatsappTemplates: count(templates.docs),
    snippets: count(snippets.docs),
    smartLists: count(smartLists.docs),
    workspaceSettings: names.test(JSON.stringify(sub.data() ?? {})),
    // Held outside the workspace, so not scanned here.
    notChecked: "the agency's template library and snapshots",
  };
}
