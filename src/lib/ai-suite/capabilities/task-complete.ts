import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { setTaskCompletedServerSide } from "@/lib/server/tasks-service";
import { territoryScopeFor } from "@/lib/ai-suite/territory-scope";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str, assertInTerritory } from "./helpers";

export const TASK_COMPLETE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "complete_task",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Mark a task as done",
    description:
      "Mark one of this workspace's tasks as completed. Resolve the task's id with find_tasks first — never guess ids. This fires the same task.completed webhook + contact-timeline activity as ticking it off on the Tasks page.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task's id, exactly as returned by find_tasks.",
        },
        taskTitle: {
          type: "string",
          description: "The task's title, for the confirmation card.",
        },
      },
      required: ["taskId", "taskTitle"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const taskId = str(raw, "taskId");
      if (!taskId) {
        return {
          ok: false,
          error:
            "the task id is required — I need to find it first (find_tasks)",
        };
      }
      return { ok: true, args: { taskId, taskTitle: str(raw, "taskTitle") } };
    },
    summarize: (args) =>
      `Mark the task “${args.taskTitle || args.taskId}” as done.`,
    execute: async (ctx, args) => {
      // The id came from the model — verify it's in THIS workspace.
      const snap = await getAdminDb()
        .doc(`tasks/${args.taskId as string}`)
        .get();
      if (!snap.exists || snap.data()?.subAccountId !== ctx.subAccountId) {
        throw new CapabilityUserError(
          "That task wasn't found in this workspace."
        );
      }
      assertInTerritory(
        await territoryScopeFor(ctx),
        snap.data()?.territoryId,
        "That task"
      );
      const title =
        (snap.data()?.title as string) || (args.taskTitle as string);
      if (snap.data()?.completed === true) {
        return {
          resultText: `“${title}” is already marked done — nothing to change.`,
          ref: { kind: "task", id: snap.id },
        };
      }
      await setTaskCompletedServerSide({
        taskId: snap.id,
        completed: true,
        userId: ctx.uid,
        expectedSubAccountId: ctx.subAccountId!,
      });
      return {
        resultText: `Marked “${title}” as done.`,
        ref: { kind: "task", id: snap.id },
      };
    },
  },
];
