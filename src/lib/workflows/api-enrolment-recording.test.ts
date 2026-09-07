import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowDoc } from "@/types/workflows";

/**
 * The reconciling half of the public-API enrolment cap. The route has
 * already RESERVED one enrolment; the engine settles it against the number
 * of workflows the contact actually entered — on every exit path, or a
 * request that enrolled nobody would keep its reservation for the hour.
 * Nothing is reconciled for a dashboard write, which reserved nothing.
 */

let workflows: Pick<WorkflowDoc, "id" | "trigger" | "startNodeId">[] = [];
/** Makes the enrolment write blow up, as a Firestore outage would. */
let enrollThrows = false;
const reconcileEnrolments = vi.fn();

vi.mock("@/lib/api/enrolment-cap", () => ({
  reconcileEnrolments: (...a: unknown[]) => reconcileEnrolments(...a),
}));
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
            set: async () => {
              if (enrollThrows) throw new Error("enroll failed");
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

const wf = (id: string) => ({
  id,
  startNodeId: "n1",
  trigger: { type: "contact.tag.added" as const, filters: { all: [] } },
});

const fire = (apiKeyId?: string) =>
  fireWorkflowTrigger({
    agencyId: "ag1",
    subAccountId: "sa1",
    type: "contact.tag.added",
    contactId: "c1",
    apiKeyId,
  });

beforeEach(() => {
  reconcileEnrolments.mockReset();
  enrollThrows = false;
  workflows = [wf("wfA")];
});

describe("fireWorkflowTrigger — API enrolment accounting", () => {
  it("settles the reservation at one enrolment per workflow entered", async () => {
    workflows = [wf("wfA"), wf("wfB")];

    await fire("key1");

    expect(reconcileEnrolments).toHaveBeenCalledTimes(1);
    expect(reconcileEnrolments).toHaveBeenCalledWith({
      subAccountId: "sa1",
      keyId: "key1",
      actual: 2,
    });
  });

  it("hands the reservation back when no workflow matched", async () => {
    workflows = [];

    await fire("key1");

    expect(reconcileEnrolments).toHaveBeenCalledWith({
      subAccountId: "sa1",
      keyId: "key1",
      actual: 0,
    });
  });

  it("still settles when enrolment throws part-way", async () => {
    enrollThrows = true;
    workflows = [wf("wfA")];

    await fire("key1");

    expect(reconcileEnrolments).toHaveBeenCalledWith({
      subAccountId: "sa1",
      keyId: "key1",
      actual: 0,
    });
  });

  it("reconciles nothing for a dashboard write (no API key)", async () => {
    await fire(undefined);

    expect(reconcileEnrolments).not.toHaveBeenCalled();
  });
});
