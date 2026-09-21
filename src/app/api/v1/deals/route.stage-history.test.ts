import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { mintApiKey } from "@/lib/api/keys";

/**
 * Public API v1 deal writes append stage-history rows, through the REAL
 * withApiAuth and routes over an in-memory Firestore. This is the path the
 * QContact stage sync uses. Stubbed: webhooks and the workflow engine.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const { POST } = await import("./route");
const { PATCH } = await import("./[id]/route");

let key = "";
let prefix = "";
const rows = () => mem.list("dealStageHistory");
const req = (method: string, path: string, body: unknown) =>
  new Request(`https://app.test${path}`, {
    method, headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body),
  });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { name: "SA", agencyId: "ag1", apiAccessEnabledByAgency: true });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann" });
  const k = mintApiKey("live");
  mem.seed("subAccounts/sa1/apiKeys/key1", {
    subAccountId: "sa1", agencyId: "ag1", name: "k", mode: "live", prefix: k.prefix,
    hashedSecret: k.hashedSecret, scopes: ["admin"], revokedAt: null,
  });
  key = k.rawKey;
  prefix = k.prefix;
});

it("POST writes the entry row and PATCH stage appends a move row; a same-stage PATCH does not", async () => {
  const created = await POST(
    req("POST", "/api/v1/deals", { title: "D", value: 1, currency: "USD", contact_id: "c1", stage: "new" }),
    { params: Promise.resolve({}) },
  );
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { deal: { id: string } }).deal.id;
  expect(rows()).toEqual([
    expect.objectContaining({
      dealId: id, stageId: "new", fromStageId: null, source: "api",
      createdByUid: `apikey:${prefix}`, subAccountId: "sa1", agencyId: "ag1", mode: "live",
    }),
  ]);

  const patch = (body: unknown) =>
    PATCH(req("PATCH", `/api/v1/deals/${id}`, body), { params: Promise.resolve({ id }) });
  expect((await patch({ stage: "qualified" })).status).toBe(200);
  expect((await patch({ stage: "qualified", title: "Renamed" })).status).toBe(200);
  expect(rows().filter((r) => r.fromStageId !== null)).toEqual([
    expect.objectContaining({ dealId: id, fromStageId: "new", stageId: "qualified", source: "api" }),
  ]);
  expect(mem.read(`deals/${id}`)?.stageId).toBe("qualified");
});
