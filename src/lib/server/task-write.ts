import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { serializeTaskForApi, type TaskPatchInput } from "@/lib/api/serializers/tasks";
import { refInSubAccount } from "@/lib/server/tenant-ref";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Patching a task, shared by `PATCH /api/v1/tasks/[id]` and the agent's
 * update_task: the tenancy (and, for a key, mode) check, re-links that must
 * name a record in the sub-account, the completed edge and its webhook.
 */

type Mode = "live" | "test";
type Failure = { ok: false; code: "task_not_found" | "contact_not_found" | "deal_not_found" | "event_not_found" };

export async function patchTaskServerSide(opts: {
  taskId: string;
  subAccountId: string;
  agencyId: string;
  /** A v1 key's mode: the task and its links must be in it. Omitted = not checked. */
  mode?: Mode;
  patch: TaskPatchInput;
  /** Further fields written with the patch (an agent's territory and edit stamp). */
  extra?: Record<string, unknown>;
}): Promise<{ ok: true; task: ReturnType<typeof serializeTaskForApi> } | Failure> {
  const { patch, mode } = opts;
  const ref = getAdminDb().doc(`tasks/${opts.taskId}`);
  const snap = await ref.get();
  const existing = snap.data();
  if (!existing || existing.subAccountId !== opts.subAccountId || (mode !== undefined && existing.mode !== mode)) {
    return { ok: false, code: "task_not_found" };
  }

  // A re-link must name a record in this sub-account (+ mode), as on create.
  for (const [collection, id, code] of [
    ["contacts", patch.contactId, "contact_not_found"],
    ["deals", patch.dealId, "deal_not_found"],
    ["events", patch.eventId, "event_not_found"],
  ] as const) {
    if (id && !(await refInSubAccount(collection, id, opts.subAccountId, mode))) return { ok: false, code };
  }

  const wasCompleted = !!existing.completed;
  const writePatch: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
    ...opts.extra,
  };
  if (patch.title !== undefined) writePatch.title = patch.title;
  if (patch.notes !== undefined) writePatch.notes = patch.notes;
  if (patch.dueAt !== undefined) writePatch.dueAt = patch.dueAt;
  if (patch.contactId !== undefined) writePatch.contactId = patch.contactId;
  if (patch.dealId !== undefined) writePatch.dealId = patch.dealId;
  if (patch.eventId !== undefined) writePatch.eventId = patch.eventId;

  let firedCompleted = false;
  if (patch.completed !== undefined) {
    writePatch.completed = patch.completed;
    if (patch.completed && !wasCompleted) {
      writePatch.completedAt = FieldValue.serverTimestamp();
      firedCompleted = true;
    } else if (!patch.completed && wasCompleted) {
      writePatch.completedAt = null;
    }
  }

  await ref.set(writePatch, { merge: true });
  const wireMode = mode ?? ((existing.mode as Mode | undefined) ?? "live");
  const fresh = await ref.get();
  const task = serializeTaskForApi(fresh.id, fresh.data()!, wireMode);

  if (firedCompleted) {
    runAfterResponse(() => emitWebhookEvent({
      subAccountId: opts.subAccountId,
      agencyId: opts.agencyId,
      mode: wireMode,
      type: "task.completed",
      payload: { task },
    }));
  }
  return { ok: true, task };
}
