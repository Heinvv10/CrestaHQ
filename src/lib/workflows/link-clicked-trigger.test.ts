import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowDoc } from "@/types/workflows";

/**
 * The per-link narrowing on `link.clicked`, mirroring `form.submitted`'s
 * per-form filter.
 *
 * A campaign has one workflow per report link. Without this filter every
 * click on ANY link enrols the contact in ALL of them — which for these
 * workflows means one WhatsApp per link in the account.
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
              data: () => ({
                ...w,
                subAccountId: "sa1",
                agencyId: "ag1",
                nodes: {},
              }),
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

const wf = (id: string, linkId?: string | null) => ({
  id,
  startNodeId: "n1",
  trigger: {
    type: "link.clicked" as const,
    filters: { all: [] },
    ...(linkId === undefined ? {} : { linkId }),
  },
});

beforeEach(() => {
  enrolledWorkflowIds.length = 0;
});

describe("fireWorkflowTrigger — link.clicked", () => {
  it("enrols only the workflow filtered to the clicked link", async () => {
    workflows = [wf("wfA", "linkA"), wf("wfB", "linkB")];

    await fireWorkflowTrigger({
      agencyId: "ag1",
      subAccountId: "sa1",
      type: "link.clicked",
      contactId: "c1",
      context: { linkId: "linkA" },
    });

    expect(enrolledWorkflowIds).toEqual(["wfA"]);
  });

  it("enrols an unfiltered workflow on any link", async () => {
    workflows = [wf("wfAny", null), wf("wfB", "linkB")];

    await fireWorkflowTrigger({
      agencyId: "ag1",
      subAccountId: "sa1",
      type: "link.clicked",
      contactId: "c1",
      context: { linkId: "linkA" },
    });

    expect(enrolledWorkflowIds).toEqual(["wfAny"]);
  });
});
