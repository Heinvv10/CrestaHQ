import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * PATCH /api/v1/contacts/:id → a real workflow run.
 *
 * route.test.ts proves the route hands the service's tag diff to
 * `fireWorkflowTrigger`, but it mocks that function, so it cannot show that
 * anyone is enrolled. This drives the same PATCH through the real contact
 * service AND the real engine, over an in-memory Firestore that honours
 * query filters, and asserts on the thing that matters: a `workflowRuns` doc
 * for a workflow whose trigger is `contact.tag.added`.
 *
 * Only the edges are stubbed — auth (not the seam), outbound webhooks, and
 * QStash, which is where a run's first step would leave the process.
 */

const CTX = {
  agencyId: "ag1",
  subAccountId: "sa1",
  keyId: "key1",
  keyPrefix: "lsk_abcd",
  mode: "live" as "live" | "test",
  scopes: ["admin"],
  requestId: "req_test",
  apiVersion: "2026-01-01",
};

const mem = createMemoryFirestore();
const published: Array<{ body: Record<string, unknown> }> = [];
/** Every trigger the service fired, so a test can wait for it to settle. */
const triggers: Promise<unknown>[] = [];

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/auth", () => ({
  withApiAuth:
    (handler: (input: Record<string, unknown>) => Promise<Response>) =>
    async (request: Request, routeCtx: { params: Promise<{ id: string }> }) => {
      const rawBody = await request.text();
      return handler({
        request,
        params: await routeCtx.params,
        body: rawBody ? JSON.parse(rawBody) : null,
        rawBody,
        ctx: CTX,
      });
    },
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({
  emitWebhookEvent: async () => undefined,
}));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async (input: { body: Record<string, unknown> }) => {
    published.push(input);
    return { messageId: `msg_${published.length}` };
  },
}));
// Pass-through: the REAL engine runs. The wrapper only records the promise
// the service discards with `void`, so a test can await the enrolment
// instead of sleeping.
vi.mock("@/lib/workflows/engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/workflows/engine")>();
  return {
    ...real,
    fireWorkflowTrigger: (input: Parameters<typeof real.fireWorkflowTrigger>[0]) => {
      const p = real.fireWorkflowTrigger(input);
      triggers.push(p);
      return p;
    },
  };
});

const { PATCH } = await import("./route");

const TRIGGER_TAG = "velocity-review-ready";

async function patch(body: Record<string, unknown>): Promise<Response> {
  const res = (await PATCH(
    new Request("https://app.test/api/v1/contacts/c1", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "c1" }) },
  )) as unknown as Response;
  await Promise.all(triggers);
  return res;
}

function seedWorkflow(id: string, filterTag: string) {
  mem.seed(`workflows/${id}`, {
    subAccountId: "sa1",
    agencyId: "ag1",
    status: "active",
    startNodeId: "n1",
    nodes: { n1: { id: "n1", type: "add_tag", config: { tag: "x" } } },
    trigger: {
      type: "contact.tag.added",
      filters: { all: [{ field: "tags", op: "has_tag", value: filterTag }] },
    },
    stats: { enrolled: 0 },
  });
}

const runs = () => mem.list("workflowRuns");
const bucket = () =>
  mem
    .list("subAccounts/sa1/apiEnrolments")
    .reduce((n, d) => n + ((d.count as number) ?? 0), 0);

beforeEach(() => {
  mem.clear();
  CTX.mode = "live";
  published.length = 0;
  triggers.length = 0;
  mem.seed("subAccounts/sa1", { name: "Velocity", automationsPaused: false });
  mem.seed("contacts/c1", {
    name: "Thandi Mokoena",
    email: "",
    phone: "+27821234567",
    tags: ["customer"],
    customFields: {},
    subAccountId: "sa1",
    agencyId: "ag1",
    mode: "live",
  });
  seedWorkflow("wf_review", TRIGGER_TAG);
});

describe("PATCH /api/v1/contacts/:id — a tag enrols a real workflow run", () => {
  it("enrols the contact in the contact.tag.added workflow and schedules its first step", async () => {
    const res = await patch({ tags: ["customer", TRIGGER_TAG] });

    expect(res.status).toBe(200);
    const enrolled = runs();
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0]).toMatchObject({
      contactId: "c1",
      subAccountId: "sa1",
      status: "running",
      currentNodeId: "n1",
      context: { addedTags: [TRIGGER_TAG] },
    });
    // The run left the process: its start node was handed to QStash.
    expect(published.map((p) => p.body)).toEqual([
      { runId: enrolled[0].id, nodeId: "n1" },
    ]);
    // Reserved one, enrolled one — the fuse is charged exactly once.
    expect(bucket()).toBe(1);
  });

  it("does not enrol again when the same tag is PATCHed a second time", async () => {
    await patch({ tags: ["customer", TRIGGER_TAG] });
    await patch({ tags: ["customer", TRIGGER_TAG] });

    expect(runs()).toHaveLength(1);
    expect(bucket()).toBe(1);
  });

  it("does not enrol when the added tag is not the one the workflow filters on", async () => {
    // A different tag fires contact.tag.added, but this workflow's filter
    // wants TRIGGER_TAG, which the contact does not carry.
    const res = await patch({ tags: ["customer", "newsletter"] });

    expect(res.status).toBe(200);
    expect(runs()).toHaveLength(0);
    expect(published).toHaveLength(0);
    // The reservation was handed back when nobody enrolled.
    expect(bucket()).toBe(0);
  });

  it("enrols nobody for a test-mode key", async () => {
    CTX.mode = "test";
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), mode: "test" });

    const res = await patch({ tags: ["customer", TRIGGER_TAG] });

    expect(res.status).toBe(200);
    expect(runs()).toHaveLength(0);
    expect(published).toHaveLength(0);
  });
});
