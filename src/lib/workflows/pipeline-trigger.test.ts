import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowDoc } from "@/types/workflows";

/**
 * The per-pipeline narrowing on the deal triggers. A workflow pinned to
 * pipeline P2 must NOT fire for a stage change in P1, and — the direction
 * that a filter comparing the wrong field would also pass — it MUST fire
 * for P2. A workflow with no pipeline set fires for either (every workflow
 * saved before pipelines existed).
 */

const enrolledWorkflowIds: string[] = [];
let workflows: Pick<WorkflowDoc, "id" | "trigger" | "startNodeId">[] = [];

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => ({
        exists: true,
        id: path.split("/")[1],
        data: () =>
          path.startsWith("contacts/")
            ? { subAccountId: "sa1", agencyId: "ag1", tags: [] }
            : {},
      }),
      update: async () => undefined,
    }),
    // enroll() writes the run with its enrolment lock in one batch; replay the
    // sets on the refs so the run's set() still records (or throws).
    batch: () => {
      const sets: Array<() => Promise<unknown> | undefined> = [];
      const b = {
        set: (ref: { set?: (d: unknown) => Promise<unknown> }, d: unknown) =>
          (sets.push(() => ref.set?.(d)), b),
        commit: async () => {
          for (const s of sets) await s();
        },
      };
      return b;
    },
    collection: (name: string) => {
      if (name === "workflows") {
        const q = {
          where: () => q,
          get: async () => ({
            empty: workflows.length === 0,
            docs: workflows.map((w) => ({
              id: w.id,
              data: () => ({ ...w, subAccountId: "sa1", agencyId: "ag1", nodes: {} }),
            })),
          }),
        };
        return q;
      }
      if (name === "workflowRuns") {
        return {
          doc: () => ({
            id: "run1",
            set: async (data: Record<string, unknown>) => {
              enrolledWorkflowIds.push(data.workflowId as string);
            },
            update: async () => undefined,
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  }),
}));

const { fireWorkflowTrigger } = await import("./engine");

const wf = (
  id: string,
  type: WorkflowDoc["trigger"]["type"],
  narrow: { pipelineId?: string | null; toStage?: string | null } = {},
) => ({
  id,
  startNodeId: "n1",
  trigger: { type, filters: { all: [] }, ...narrow },
});

const fire = (type: WorkflowDoc["trigger"]["type"], context: Record<string, unknown>) =>
  fireWorkflowTrigger({ agencyId: "ag1", subAccountId: "sa1", type, contactId: "c1", context });

beforeEach(() => {
  // Fresh state per test: the workflow list AND the enrolment log. A test
  // that forgot to set `workflows` must see none, not the previous test's.
  workflows = [];
  enrolledWorkflowIds.length = 0;
});

describe("fireWorkflowTrigger — pipeline narrowing", () => {
  it("pipeline.stage.changed: pinned to P2 does not fire for P1, does fire for P2", async () => {
    workflows = [wf("pinnedP2", "pipeline.stage.changed", { pipelineId: "p2" })];

    await fire("pipeline.stage.changed", { pipelineId: "p1", toStage: "open" });
    expect(enrolledWorkflowIds).toEqual([]);

    await fire("pipeline.stage.changed", { pipelineId: "p2", toStage: "open" });
    expect(enrolledWorkflowIds).toEqual(["pinnedP2"]);
  });

  it("pipeline + stage together: both must match", async () => {
    workflows = [
      wf("p2open", "pipeline.stage.changed", { pipelineId: "p2", toStage: "open" }),
    ];
    await fire("pipeline.stage.changed", { pipelineId: "p2", toStage: "closed" });
    await fire("pipeline.stage.changed", { pipelineId: "p1", toStage: "open" });
    expect(enrolledWorkflowIds).toEqual([]);
    await fire("pipeline.stage.changed", { pipelineId: "p2", toStage: "open" });
    expect(enrolledWorkflowIds).toEqual(["p2open"]);
  });

  it("no pipeline set (pre-multi-pipeline doc) fires for any pipeline", async () => {
    workflows = [wf("any", "pipeline.stage.changed"), wf("anyNull", "pipeline.stage.changed", { pipelineId: null })];
    await fire("pipeline.stage.changed", { pipelineId: "p1", toStage: "open" });
    await fire("pipeline.stage.changed", { pipelineId: "default", toStage: "won" });
    expect(enrolledWorkflowIds).toEqual(["any", "anyNull", "any", "anyNull"]);
  });

  it.each(["deal.created", "deal.won", "deal.lost"] as const)(
    "%s honours the pipeline filter in both directions",
    async (type) => {
      workflows = [wf("pinned", type, { pipelineId: "p2" }), wf("open", type)];
      await fire(type, { pipelineId: "p1" });
      expect(enrolledWorkflowIds).toEqual(["open"]);
      await fire(type, { pipelineId: "p2" });
      expect(enrolledWorkflowIds).toEqual(["open", "pinned", "open"]);
    },
  );
});
