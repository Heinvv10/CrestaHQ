import { beforeEach, expect, it, vi } from "vitest";

/** createTaskServerSide leaves a `task_created` row on the linked contact. */

const m = vi.hoisted(() => ({
  activityAdds: [] as Array<{ path: string; data: Record<string, unknown> }>,
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => {} }));
vi.mock("@/lib/api/serializers/tasks", () => ({
  serializeTaskForApi: (id: string) => ({ id }),
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: () => ({ get: async () => ({ data: () => ({ territoryId: "global" }) }) }),
    collection: (name: string) => ({
      doc: (id?: string) => ({
        id: id ?? "task_1",
        set: async () => {},
        collection: (sub: string) => ({
          add: async (data: Record<string, unknown>) => {
            m.activityAdds.push({ path: `${name}/${id}/${sub}`, data });
            return { id: "act1" };
          },
        }),
      }),
    }),
  }),
}));
import { createTaskServerSide } from "./tasks-service";

const input = {
  subAccountId: "sa_1",
  agencyId: "ag_1",
  createdByUid: "u_1",
  mode: "live" as const,
  title: "Call back about install",
  notes: "",
  dueAt: new Date("2026-09-12T08:00:00.000Z"),
  dealId: null,
  eventId: null,
};

beforeEach(() => {
  m.activityAdds.length = 0;
});

it("writes task_created on the linked contact with title, dueAt and tenant keys", async () => {
  const { id } = await createTaskServerSide({ ...input, contactId: "c_1" });
  expect(id).toBe("task_1");
  expect(m.activityAdds).toEqual([
    {
      path: "contacts/c_1/activities",
      data: expect.objectContaining({
        type: "task_created",
        content: 'Task created: "Call back about install"',
        createdBy: "u_1",
        agencyId: "ag_1",
        subAccountId: "sa_1",
        meta: { taskId: "task_1", dueAt: "2026-09-12T08:00:00.000Z" },
      }),
    },
  ]);
});

it("writes nothing for a task with no contact", async () => {
  await createTaskServerSide({ ...input, contactId: null });
  expect(m.activityAdds).toEqual([]);
});
