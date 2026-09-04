import "server-only";

import type { Firestore } from "firebase-admin/firestore";
import type {
  SnapshotAiProfile,
  SnapshotCustomField,
  SnapshotForm,
  SnapshotMessageTemplate,
  SnapshotPayload,
  SnapshotProduct,
  SnapshotWorkflow,
} from "@/types/snapshots";

/**
 * Fields stamped per-tenant. Stripped on capture so they never travel inside
 * a snapshot — apply re-stamps fresh values on the target sub-account.
 */
const TENANCY_STAMPS = [
  "id",
  "agencyId",
  "subAccountId",
  "createdByUid",
  "createdAt",
  "updatedAt",
] as const;

/**
 * Strip tenancy/identity/audit fields (plus any per-entity runtime fields)
 * from a stored doc, keeping the original doc id as `sourceId`. The `sourceId`
 * lets apply build an old→new form-id map and remap workflow triggers.
 */
function stripDoc(
  id: string,
  data: FirebaseFirestore.DocumentData,
  extraOmit: readonly string[] = [],
): Record<string, unknown> {
  const omit = new Set<string>([...TENANCY_STAMPS, ...extraOmit]);
  const out: Record<string, unknown> = { sourceId: id };
  for (const [key, value] of Object.entries(data)) {
    if (!omit.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Capture a sub-account's reusable CONFIG (forms, message templates,
 * products, workflows, custom-field definitions and the AI agent persona)
 * into a portable payload. Pure reads — touches no existing data. Customer
 * data (form submissions, workflow runs, contacts, deals) is deliberately
 * never read.
 *
 * The AI persona is narrowed to its reusable fields on the way out — the
 * source client's business name, escalation inbox and scraped website KB do
 * not travel. See {@link SnapshotAiProfile} for why each is dropped.
 *
 * Runtime counters are reset in the payload: workflow `stats` is dropped
 * (re-seeded to zero on apply) and form `submissionCount` is dropped.
 */
export async function captureSnapshot(
  db: Firestore,
  sourceSubAccountId: string,
): Promise<SnapshotPayload> {
  const [
    formsSnap,
    templatesSnap,
    productsSnap,
    workflowsSnap,
    customFieldsSnap,
    aiProfileSnap,
  ] = await Promise.all([
      db.collection("forms").where("subAccountId", "==", sourceSubAccountId).get(),
      db
        .collection("message_templates")
        .where("subAccountId", "==", sourceSubAccountId)
        .get(),
      db
        .collection("products")
        .where("subAccountId", "==", sourceSubAccountId)
        .get(),
      db
        .collection("workflows")
        .where("subAccountId", "==", sourceSubAccountId)
        .get(),
      db.collection(`subAccounts/${sourceSubAccountId}/customFields`).get(),
      db.doc(`subAccounts/${sourceSubAccountId}/aiAgent/profile`).get(),
    ]);

  const forms = formsSnap.docs.map(
    (d) => stripDoc(d.id, d.data(), ["submissionCount"]) as unknown as SnapshotForm,
  );
  const messageTemplates = templatesSnap.docs.map(
    (d) => stripDoc(d.id, d.data()) as unknown as SnapshotMessageTemplate,
  );
  const products = productsSnap.docs.map(
    (d) => stripDoc(d.id, d.data()) as unknown as SnapshotProduct,
  );
  const workflows = workflowsSnap.docs.map(
    (d) => stripDoc(d.id, d.data(), ["stats"]) as unknown as SnapshotWorkflow,
  );

  const customFields = customFieldsSnap.docs.map(
    (d) => stripDoc(d.id, d.data()) as unknown as SnapshotCustomField,
  );

  // Only the reusable half of the persona travels. An empty prompt means the
  // operator never set one up, so there is nothing worth carrying.
  const profile = aiProfileSnap.data();
  const aiProfile: SnapshotAiProfile | null =
    profile && typeof profile.systemPrompt === "string" && profile.systemPrompt.trim()
      ? {
          systemPrompt: profile.systemPrompt,
          hoursStart: profile.hoursStart ?? 0,
          hoursEnd: profile.hoursEnd ?? 0,
          timezone: profile.timezone ?? "UTC",
          escalationKeywords: Array.isArray(profile.escalationKeywords)
            ? profile.escalationKeywords
            : [],
        }
      : null;

  return { forms, messageTemplates, products, workflows, customFields, aiProfile };
}
