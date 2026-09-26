import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Stored text in this workspace that names a custom field by its key
 * (`customFields.<key>`, the form conditions and merge tags use): workflows
 * (triggers, conditions, step text), email / SMS templates (which broadcasts
 * send), WhatsApp templates (variable merge tags), snippets, and the
 * workspace's own settings (e.g. the missed-call text-back). After a delete,
 * those read the field as empty. `notChecked` names what this can't see.
 */
export async function customFieldUsage(
  subAccountId: string,
  key: string,
): Promise<{
  workflows: number;
  messageTemplates: number;
  whatsappTemplates: number;
  snippets: number;
  workspaceSettings: boolean;
  notChecked: string;
}> {
  const db = getAdminDb();
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = new RegExp(`customFields\\.${escaped}(?![A-Za-z0-9_])`);
  const [workflows, messageTemplates, templates, snippets, sub] = await Promise.all([
    db.collection("workflows").where("subAccountId", "==", subAccountId).get(),
    db.collection("message_templates").where("subAccountId", "==", subAccountId).get(),
    db.collection(`subAccounts/${subAccountId}/whatsappTemplates`).get(),
    db.collection("snippets").where("subAccountId", "==", subAccountId).get(),
    db.doc(`subAccounts/${subAccountId}`).get(),
  ]);
  const count = (docs: FirebaseFirestore.QueryDocumentSnapshot[]) =>
    docs.filter((d) => names.test(JSON.stringify(d.data()))).length;
  return {
    workflows: count(workflows.docs),
    messageTemplates: count(messageTemplates.docs),
    whatsappTemplates: count(templates.docs),
    snippets: count(snippets.docs),
    workspaceSettings: names.test(JSON.stringify(sub.data() ?? {})),
    // Held outside the workspace, so not scanned here.
    notChecked: "the agency's template library and snapshots",
  };
}
