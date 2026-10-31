import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk } from "@/lib/api/responses";
import {
  parseTaskPatch,
  serializeTaskForApi,
} from "@/lib/api/serializers/tasks";
import { patchTaskServerSide } from "@/lib/server/task-write";

export const GET = withApiAuth<{ id: string }>(async ({ params, ctx }) => {
  const snap = await getAdminDb().doc(`tasks/${params.id}`).get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "task_not_found", "Task not found.");
  }
  const d = snap.data()!;
  if (d.subAccountId !== ctx.subAccountId || d.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "task_not_found", "Task not found.");
  }
  return apiOk(ctx, { task: serializeTaskForApi(snap.id, d, ctx.mode) });
});

export const PATCH = withApiAuth<{ id: string }>(async ({ body, params, ctx }) => {
  const parsed = parseTaskPatch(body);
  if (!parsed.ok) {
    return apiError(ctx, "invalid_request", parsed.code ?? "invalid_body", parsed.error!);
  }
  const result = await patchTaskServerSide({
    taskId: params.id,
    subAccountId: ctx.subAccountId,
    agencyId: ctx.agencyId,
    mode: ctx.mode,
    patch: parsed.value!,
    actorUid: `apikey:${ctx.keyPrefix}`,
  });
  if (!result.ok) {
    return result.code === "task_not_found"
      ? apiError(ctx, "not_found", "task_not_found", "Task not found.")
      : apiError(ctx, "not_found", result.code, "Linked record not found.");
  }
  return apiOk(ctx, { task: result.task });
});

export const DELETE = withApiAuth<{ id: string }>(async ({ params, ctx }) => {
  const ref = getAdminDb().doc(`tasks/${params.id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "task_not_found", "Task not found.");
  }
  const d = snap.data()!;
  if (d.subAccountId !== ctx.subAccountId || d.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "task_not_found", "Task not found.");
  }
  await ref.delete();
  return apiOk(ctx, { id: params.id, object: "task", deleted: true });
});
