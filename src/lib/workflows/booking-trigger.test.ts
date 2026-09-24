import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowDoc } from "@/types/workflows";

/**
 * The per-booking-page narrowing on every `booking.*` trigger, mirroring
 * the deal triggers' per-pipeline filter (pipeline-trigger.test.ts). A
 * workflow pinned to page P2 must not fire for a booking on page P1 (and
 * must fire for P2), and an unfiltered workflow fires for any page —
 * including a manual (non-booking-page) event whose context carries
 * `bookingPageSlug: null`.
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
  bookingPageSlug?: string | null,
) => ({
  id,
  startNodeId: "n1",
  trigger: {
    type,
    filters: { all: [] },
    ...(bookingPageSlug === undefined ? {} : { bookingPageSlug }),
  },
});

const fire = (
  type: WorkflowDoc["trigger"]["type"],
  bookingPageSlug: string | null,
) =>
  fireWorkflowTrigger({
    agencyId: "ag1",
    subAccountId: "sa1",
    type,
    contactId: "c1",
    context: { eventId: "evt1", bookingPageSlug },
  });

beforeEach(() => {
  workflows = [];
  enrolledWorkflowIds.length = 0;
});

describe.each([
  "booking.created",
  "booking.cancelled",
  "booking.rescheduled",
  "booking.confirmed",
  "booking.showed",
  "booking.no_show",
] as const)("fireWorkflowTrigger — %s booking-page narrowing", (type) => {
  it("pinned to pageB does not fire for pageA, does fire for pageB", async () => {
    workflows = [wf("pinnedB", type, "pageB")];

    await fire(type, "pageA");
    expect(enrolledWorkflowIds).toEqual([]);

    await fire(type, "pageB");
    expect(enrolledWorkflowIds).toEqual(["pinnedB"]);
  });

  it("no page set fires for any page, including a manual event (null slug)", async () => {
    workflows = [wf("any", type), wf("anyNull", type, null)];

    await fire(type, "pageA");
    expect(enrolledWorkflowIds).toEqual(["any", "anyNull"]);

    enrolledWorkflowIds.length = 0;
    await fire(type, null);
    expect(enrolledWorkflowIds).toEqual(["any", "anyNull"]);
  });

  it("a page-pinned workflow never fires for a manual event (null slug)", async () => {
    workflows = [wf("pinnedB", type, "pageB")];

    await fire(type, null);
    expect(enrolledWorkflowIds).toEqual([]);
  });
});
