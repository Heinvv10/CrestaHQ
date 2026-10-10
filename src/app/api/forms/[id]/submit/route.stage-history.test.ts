import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { defaultFormSettings } from "@/types/forms";

/**
 * A public form submit with "create a deal" on writes the deal's entry row
 * in the same batch, through the REAL route over an in-memory Firestore.
 * Stubbed: webhooks, workflows, and the per-IP rate limit (module state).
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));
vi.mock("@/lib/forms/spam-guard", () => ({
  checkFormSpam: () => ({ kind: "ok" }),
  ELAPSED_BODY_KEY: "_elapsed",
  HONEYPOT_BODY_KEY: "_hp",
}));

const { POST } = await import("./route");

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("forms/f1", {
    name: "Contact", slug: "contact", enabled: true, submissionCount: 0,
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u_owner",
    fields: [{ id: "name", type: "text", label: "Name", required: true }],
    settings: { ...defaultFormSettings(), createDeal: true, pipelineStageId: "qualified" },
  });
});

const submit = () =>
  POST(
    new Request("http://x/api/forms/f1/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { name: "Thandi" } }),
    }),
    { params: Promise.resolve({ id: "f1" }) },
  );

it("the created deal gets its entry row", async () => {
  const res = await submit();
  const body = (await res.json()) as { dealId: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  expect(mem.read(`deals/${body.dealId}`)?.stageId).toBe("qualified");
  expect(mem.list("dealStageHistory")).toEqual([
    expect.objectContaining({
      dealId: body.dealId, fromStageId: null, stageId: "qualified", pipelineId: "default",
      source: "form", subAccountId: "sa1", agencyId: "ag1", mode: "live",
    }),
  ]);
});

it("a configured stage since deleted from the default pipeline falls back to its first stage", async () => {
  mem.seed("subAccounts/sa1/pipelines/default", {
    name: "Default", isDefault: true, agencyId: "ag1", subAccountId: "sa1",
    stages: [{ id: "inbound", label: "Inbound", tone: "" }, { id: "won", label: "Won", tone: "", terminal: "won" }],
  });
  const res = await submit();
  const body = (await res.json()) as { dealId: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  expect(mem.read(`deals/${body.dealId}`)?.stageId).toBe("inbound");
});
