import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import { patchTaskServerSide } from "@/lib/server/task-write";
import { territoryForContact } from "@/lib/server/tasks-service";
import type { TaskPatchInput } from "@/lib/api/serializers/tasks";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { agentActor, ISO_DATE_RE, str, toDate } from "./helpers";
import { hasUnsafeText, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";

/**
 * Editing and deleting tasks for API agents (AGENT_API_V1_PLAN.md, PR12).
 * update_task is a direct write through the v1 task route's own patch
 * (task-write.ts); a task messages nobody. delete_task is hard, so a
 * sub-account admin approves it, reading the whole task.
 */

const taskIdParam = { type: "string", description: "The task's id (from find_tasks)." };
const LINKS = { contactId: "contacts", dealId: "deals", eventId: "events" } as const;
const NOT_FOUND: Record<string, string> = {
  task_not_found: "That task isn't in this workspace.",
  contact_not_found: "That contact isn't in this workspace.",
  deal_not_found: "That deal isn't in this workspace.",
  event_not_found: "That appointment isn't in this workspace.",
};

async function tenantTask(subAccountId: string, taskId: unknown): Promise<FirebaseFirestore.DocumentData & { id: string }> {
  const snap = isDocId(taskId) ? await getAdminDb().doc(`tasks/${taskId}`).get() : null;
  const data = snap?.data();
  if (!data || data.subAccountId !== subAccountId) throw new CapabilityUserError(NOT_FOUND.task_not_found);
  return { ...data, id: snap!.id };
}

export const TASK_EDIT_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "update_task",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Edit a task",
    description:
      "Edit a task's title, notes, due date (YYYY-MM-DD, or null to clear) or linked contact / deal / appointment (null unlinks). Use complete_task to tick it off.",
    parameters: {
      type: "object",
      properties: {
        taskId: taskIdParam,
        title: { type: "string" },
        notes: { type: "string" },
        dueAt: { type: ["string", "null"] },
        contactId: { type: ["string", "null"] },
        dealId: { type: ["string", "null"] },
        eventId: { type: ["string", "null"] },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const taskId = str(raw, "taskId");
      if (!isDocId(taskId)) return { ok: false, error: "a taskId is required" };
      const args: Record<string, unknown> = { taskId };
      for (const k of ["title", "notes"] as const) {
        if (r[k] === undefined) continue;
        if (typeof r[k] !== "string" || hasUnsafeText(r[k] as string)) return { ok: false, error: `${k} must be text (${UNSAFE_TEXT_MESSAGE} is refused)` };
        args[k] = (r[k] as string).trim();
      }
      if (args.title === "") return { ok: false, error: "the title can't be empty" };
      if (r.dueAt !== undefined) {
        if (r.dueAt !== null && !(typeof r.dueAt === "string" && ISO_DATE_RE.test(r.dueAt) && !isNaN(Date.parse(r.dueAt)))) {
          return { ok: false, error: "dueAt must be YYYY-MM-DD or null" };
        }
        args.dueAt = r.dueAt;
      }
      for (const k of Object.keys(LINKS)) {
        if (r[k] === undefined) continue;
        if (r[k] !== null && !isDocId(r[k])) return { ok: false, error: `${k} must be an id or null` };
        args[k] = r[k];
      }
      if (Object.keys(args).length === 1) return { ok: false, error: "give at least one field to change" };
      return { ok: true, args };
    },
    summarize: () => "Edit a task.",
    execute: async (ctx, args) => {
      const { taskId, dueAt, ...rest } = args;
      const task = await tenantTask(ctx.subAccountId!, taskId);
      const patch: TaskPatchInput = { ...(rest as TaskPatchInput) };
      if (dueAt !== undefined) patch.dueAt = dueAt === null ? null : new Date(`${dueAt as string}T00:00:00.000Z`);
      const extra: Record<string, unknown> = { ...agentEditStamp(agentActor(ctx, "update_task")) };
      // The task's territory follows its contact, as the Tasks page sets it.
      if (patch.contactId !== undefined) extra.territoryId = await territoryForContact(patch.contactId);
      const result = await patchTaskServerSide({ taskId: task.id, subAccountId: ctx.subAccountId!, agencyId: ctx.agencyId, patch, extra });
      if (!result.ok) throw new CapabilityUserError(NOT_FOUND[result.code]);
      return { resultText: "Updated the task.", ref: { kind: "task", id: task.id } };
    },
  },
  {
    name: "delete_task",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    approval: "hard_delete",
    menuLabel: "Delete a task (a person approves)",
    description: "Delete a task permanently. Queued for a sub-account admin to approve.",
    parameters: { type: "object", properties: { taskId: taskIdParam }, required: ["taskId"], additionalProperties: false },
    validate: (raw) => {
      const taskId = str(raw, "taskId");
      return isDocId(taskId) ? { ok: true, args: { taskId } } : { ok: false, error: "a taskId is required" };
    },
    summarize: () => "Delete a task.",
    approvalTarget: async (ctx, args) => {
      const t = await tenantTask(ctx.subAccountId!, args.taskId);
      return { contactId: isDocId(t.contactId) ? t.contactId : null, territoryId: (t.territoryId as string | undefined) ?? null, scoped: true };
    },
    preview: async (ctx, args) => {
      const t = await tenantTask(ctx.subAccountId!, args.taskId);
      const due = toDate(t.dueAt);
      return [
        { label: "Delete task", value: oneLine(t.title) || "(untitled)" },
        ...recordProvenanceRows(t.id, t),
        { label: "Notes", value: oneLine(t.notes) || "(none)" },
        { label: "Due", value: due ? due.toISOString().slice(0, 10) : "(none)" },
        { label: "Done", value: t.completed === true ? "yes" : "no" },
        { label: "Linked to", value: Object.keys(LINKS).filter((k) => t[k]).map((k) => `${k.replace("Id", "")} ${t[k]}`).join(", ") || "nothing" },
        { label: "Assigned to", value: (t.assignedToUid as string | undefined) || "nobody" },
      ];
    },
    execute: async (ctx, args) => {
      const t = await tenantTask(ctx.subAccountId!, args.taskId);
      const db = getAdminDb();
      const ref = db.doc(`tasks/${t.id}`);
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (!current || current.subAccountId !== ctx.subAccountId) throw new CapabilityUserError(NOT_FOUND.task_not_found);
        tx.delete(ref);
      });
      return { resultText: "Deleted the task.", ref: { kind: "task", id: t.id } };
    },
  },
];
