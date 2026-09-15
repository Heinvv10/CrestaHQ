import "server-only";

import type { Firestore } from "firebase-admin/firestore";
import { applySnapshot } from "@/lib/snapshots/apply";
import type { SnapshotPayload } from "@/types/snapshots";
import type { TemplatePushResult } from "@/types/templates";

interface PushScope {
  agencyId: string;
  createdByUid: string;
}

/**
 * Push a library template's payload into each target sub-account. Every
 * target is re-anchored to the caller's agency before anything is written —
 * a foreign id is reported per-target as a failure, never thrown, so one bad
 * id in a list of fifty does not hide the forty-nine that went through.
 *
 * Runs sequentially: `applySnapshot` batches its own writes, and pushing to
 * fifty tenants at once would only trade a few seconds for a burst of
 * contention on the shared Firestore.
 */
export async function pushTemplate(
  db: Firestore,
  payload: SnapshotPayload,
  subAccountIds: string[],
  scope: PushScope,
): Promise<TemplatePushResult[]> {
  const results: TemplatePushResult[] = [];
  const none = { forms: 0, messageTemplates: 0, workflows: 0 };

  for (const subAccountId of subAccountIds) {
    const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
    if (!subSnap.exists || subSnap.data()?.agencyId !== scope.agencyId) {
      results.push({
        subAccountId,
        ok: false,
        error: "Sub-account not found in this agency.",
        created: none,
      });
      continue;
    }
    try {
      const r = await applySnapshot(db, payload, subAccountId, scope);
      results.push({
        subAccountId,
        ok: true,
        created: {
          forms: r.formsCreated,
          messageTemplates: r.templatesCreated,
          workflows: r.workflowsCreated,
        },
      });
    } catch (err) {
      console.error("[templates/push] apply failed", subAccountId, err);
      results.push({
        subAccountId,
        ok: false,
        error: err instanceof Error ? err.message : "Push failed.",
        created: none,
      });
    }
  }
  return results;
}
