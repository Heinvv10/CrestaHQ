import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { writeTaskCreatedActivity } from "@/lib/server/contact-activities";
import {
  serializeTaskForApi,
  type TaskApiObject,
} from "@/lib/api/serializers/tasks";
import { GLOBAL_TERRITORY_ID } from "@/types";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Server-side Task write service — create + complete go through here so
 * `task.created` / `task.completed` fire from the dashboard, not just the
 * public API. Plain edits + deletes have no webhook event, so they stay as
 * client-side Firestore writes.
 */

type Mode = "live" | "test";

/** Territory follows the linked contact; standalone tasks fall back to Global.
 *  Exported so every server-side document creator stamps the same value the
 *  hand-made routes do. */
export async function territoryForContact(
  contactId: string | null,
): Promise<string> {
  if (!contactId || !isDocId(contactId)) return GLOBAL_TERRITORY_ID;
  try {
    const snap = await getAdminDb().doc(`contacts/${contactId}`).get();
    const raw = snap.data()?.territoryId;
    return typeof raw === "string" ? raw : GLOBAL_TERRITORY_ID;
  } catch {
    return GLOBAL_TERRITORY_ID;
  }
}

export interface CreateTaskInput {
  subAccountId: string;
  agencyId: string;
  createdByUid: string;
  mode: Mode;
  title: string;
  notes: string;
  dueAt: Date | null;
  contactId: string | null;
  dealId: string | null;
  eventId: string | null;
  assignedToUid?: string | null;
  /** Set by the workflow engine so the `task_created` timeline row links
   *  back to the run that minted the task. */
  workflow?: { workflowId: string; runId: string };
}

export interface TaskWriteResult {
  id: string;
  task: TaskApiObject;
}

/** Create a task + emit `task.created` (+ a `task_created` activity on the
 *  linked contact). */
export async function createTaskServerSide(
  input: CreateTaskInput,
): Promise<TaskWriteResult> {
  const db = getAdminDb();
  const territoryId = await territoryForContact(input.contactId);
  const ref = db.collection("tasks").doc();

  const doc = {
    title: input.title,
    notes: input.notes,
    dueAt: input.dueAt,
    completed: false,
    completedAt: null,
    contactId: input.contactId,
    dealId: input.dealId,
    eventId: input.eventId,
    assignedToUid: input.assignedToUid ?? null,
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    territoryId,
    mode: input.mode,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);

  const now = new Date();
  const task = serializeTaskForApi(
    ref.id,
    { ...doc, createdAt: now, updatedAt: now },
    input.mode,
  );

  runAfterResponse(() => emitWebhookEvent({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    mode: input.mode,
    type: "task.created",
    payload: { task },
    actorUid: input.createdByUid,
  }));

  if (input.contactId && isDocId(input.contactId)) {
    await writeTaskCreatedActivity(db, {
      contactId: input.contactId,
      taskId: ref.id,
      title: input.title,
      dueAt: input.dueAt,
      createdByUid: input.createdByUid,
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      workflow: input.workflow ?? null,
    });
  }

  return { id: ref.id, task };
}

/**
 * Flip a task's completed flag. Emits `task.completed` only on the
 * false→true edge (matches the public API), and writes the
 * `task_completed` activity on the linked contact. Returns null when the
 * task doesn't exist.
 */
export async function setTaskCompletedServerSide(opts: {
  taskId: string;
  completed: boolean;
  userId: string;
  mode?: Mode;
  /**
   * Tenancy guard: when set, the write is refused (returns null, exactly
   * like a missing doc) unless the loaded task's `subAccountId` matches.
   * This function otherwise mutates ANY task by id — callers whose taskId
   * comes from an untrusted source (the AI Suite, request payloads) MUST
   * pass this so a foreign id can't cross tenants.
   */
  expectedSubAccountId?: string;
}): Promise<TaskWriteResult | null> {
  const db = getAdminDb();
  const ref = db.doc(`tasks/${opts.taskId}`);
  const snap = await ref.get();
  if (!snap.exists) return null;
  if (
    opts.expectedSubAccountId !== undefined &&
    snap.data()?.subAccountId !== opts.expectedSubAccountId
  ) {
    return null;
  }

  const existing = snap.data()!;
  const mode = opts.mode ?? (existing.mode as Mode) ?? "live";
  const wasCompleted = !!existing.completed;

  await ref.set(
    {
      completed: opts.completed,
      completedAt: opts.completed ? FieldValue.serverTimestamp() : null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const justCompleted = opts.completed && !wasCompleted;
  // Only onto a contact in the task's own sub-account — a legacy task may
  // still hold another tenant's contactId.
  const contactId = justCompleted ? (existing.contactId as string | undefined) : undefined;
  let contactOk = false;
  if (contactId) {
    try {
      contactOk =
        isDocId(contactId) &&
        (await db.collection("contacts").doc(contactId).get()).data()?.subAccountId ===
          existing.subAccountId;
      if (!contactOk) {
        console.warn(
          `[tasks-service] tenancy refusal: contact=${contactId} is not in sa=${existing.subAccountId}; no task_completed activity task=${opts.taskId}`,
        );
      }
    } catch (err) {
      console.warn("[tasks-service] task_completed contact lookup failed", err);
    }
  }
  if (contactOk) {
    try {
      await db
        .collection("contacts")
        .doc(existing.contactId as string)
        .collection("activities")
        .add({
          type: "task_completed",
          createdBy: opts.userId,
          content: `Task completed: "${existing.title ?? ""}"`,
          meta: {},
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn("[tasks-service] task_completed activity failed", err);
    }
  }

  const fresh = await ref.get();
  const task = serializeTaskForApi(fresh.id, fresh.data()!, mode);

  if (justCompleted) {
    runAfterResponse(() => emitWebhookEvent({
      subAccountId: existing.subAccountId,
      agencyId: existing.agencyId,
      mode,
      type: "task.completed",
      payload: { task },
      actorUid: opts.userId,
    }));
  }

  return { id: fresh.id, task };
}
