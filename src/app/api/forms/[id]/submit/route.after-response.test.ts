import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { defaultFormSettings } from "@/types/forms";

/**
 * Serverless hosts freeze the function once the route returns, so the
 * submission's side-effects (workflow trigger, contact.created, the
 * form.submitted webhook) must be handed to `after()` — not started with a
 * bare `void`, which is cut off mid-flight. Real route over an in-memory
 * Firestore; `after()` collects its tasks so the test runs them itself.
 */

const m = vi.hoisted(() => ({
  afterTasks: [] as Array<() => unknown>,
  fireWorkflowTrigger: vi.fn(async () => ({ enrolled: [], skipped: [], reason: null })),
  emitWebhookEvent: vi.fn(async () => undefined),
  emitContactCreatedById: vi.fn(async () => undefined),
}));

const mem = createMemoryFirestore();
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (task: () => unknown) => m.afterTasks.push(task),
}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: m.emitWebhookEvent }));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: m.fireWorkflowTrigger }));
vi.mock("@/lib/server/contacts-service", () => ({ emitContactCreatedById: m.emitContactCreatedById }));
vi.mock("@/lib/forms/spam-guard", () => ({
  checkFormSpam: () => ({ kind: "ok" }),
  ELAPSED_BODY_KEY: "_elapsed",
  HONEYPOT_BODY_KEY: "_hp",
}));

const { POST } = await import("./route");

beforeEach(() => {
  mem.clear();
  m.afterTasks.length = 0;
  m.fireWorkflowTrigger.mockClear();
  m.emitWebhookEvent.mockClear();
  m.emitContactCreatedById.mockClear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("forms/f1", {
    name: "Contact", slug: "contact", enabled: true, submissionCount: 0,
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u_owner",
    fields: [
      { id: "name", type: "text", label: "Name", required: false, mapsTo: "name" },
      { id: "email", type: "email", label: "Email", required: false, mapsTo: "email" },
    ],
    settings: { ...defaultFormSettings(), createDeal: false },
  });
});

it("registers every side-effect with after() and starts none before the response", async () => {
  const res = await POST(
    new Request("http://x/api/forms/f1/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { name: "Thandi", email: "thandi@example.com" } }),
    }),
    { params: Promise.resolve({ id: "f1" }) },
  );
  const body = (await res.json()) as { contactId: string };
  expect(res.status).toBe(200);

  // Workflow trigger, contact.created, form.submitted webhook.
  expect(m.afterTasks).toHaveLength(3);
  expect(m.fireWorkflowTrigger).not.toHaveBeenCalled();
  expect(m.emitContactCreatedById).not.toHaveBeenCalled();
  expect(m.emitWebhookEvent).not.toHaveBeenCalled();

  await Promise.all(m.afterTasks.map((t) => t()));

  expect(m.fireWorkflowTrigger).toHaveBeenCalledWith(
    expect.objectContaining({ type: "form.submitted", contactId: body.contactId, subAccountId: "sa1" }),
  );
  expect(m.emitContactCreatedById).toHaveBeenCalledWith({
    subAccountId: "sa1", agencyId: "ag1", contactId: body.contactId,
  });
  expect(m.emitWebhookEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: "form.submitted", subAccountId: "sa1", mode: "live" }),
  );
});
