import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { mintApiKey } from "@/lib/api/keys";

/**
 * `assigned_to_uid` on POST /api/v1/deals, through the REAL withApiAuth over
 * an in-memory Firestore. It must name an ACTIVE member of the key's
 * sub-account; absent or null creates the deal unassigned.
 */

const mem = createMemoryFirestore();

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const { POST } = await import("./route");

let key = "";

async function post(body: Record<string, unknown>) {
  const res = await POST(
    new Request("https://app.test/api/v1/deals", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const dealOf = (json: Record<string, unknown>) => json.deal as Record<string, unknown>;

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { name: "SA", agencyId: "ag1", apiAccessEnabledByAgency: true });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann" });
  mem.seed("subAccounts/sa1/subAccountMembers/u_active", { status: "active" });
  mem.seed("subAccounts/sa1/subAccountMembers/u_removed", { status: "removed" });
  mem.seed("subAccounts/sa2/subAccountMembers/u_elsewhere", { status: "active" });
  const k = mintApiKey("live");
  mem.seed("subAccounts/sa1/apiKeys/key1", {
    subAccountId: "sa1", agencyId: "ag1", name: "k", mode: "live", prefix: k.prefix,
    hashedSecret: k.hashedSecret, scopes: ["admin"], revokedAt: null,
  });
  key = k.rawKey;
});

const base = { title: "Deal", value: 10, currency: "USD", contact_id: "c1", stage: "new" };

describe("POST /api/v1/deals assigned_to_uid", () => {
  it("an active member is stored and echoed", async () => {
    const res = await post({ ...base, assigned_to_uid: "u_active" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(dealOf(res.json).assigned_to_uid).toBe("u_active");
    expect(mem.read(`deals/${dealOf(res.json).id as string}`)?.assignedToUid).toBe("u_active");
  });

  it.each(["u_removed", "u_elsewhere", "u_ghost"])(
    "%s is refused with 400 invalid_request and nothing is written",
    async (uid) => {
      const res = await post({ ...base, assigned_to_uid: uid });
      expect(res.status).toBe(400);
      expect((res.json.error as { type: string }).type).toBe("invalid_request");
      expect(JSON.stringify(res.json)).toContain("not an active member");
      expect(mem.list("deals")).toHaveLength(0);
    },
  );

  it.each(["a/b", "..", "__x__"])("%s is not a doc id: 400 invalid_id, nothing written", async (uid) => {
    const res = await post({ ...base, assigned_to_uid: uid });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ type: "invalid_request", code: "invalid_id" });
    expect(mem.list("deals")).toHaveLength(0);
  });

  it("a non-string is refused", async () => {
    const res = await post({ ...base, assigned_to_uid: 42 });
    expect(res.status).toBe(400);
    expect(mem.list("deals")).toHaveLength(0);
  });

  it.each([
    ["absent", {}],
    ["null", { assigned_to_uid: null }],
  ])("%s ⇒ unassigned", async (_label, extra) => {
    const res = await post({ ...base, ...extra });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(dealOf(res.json).assigned_to_uid).toBeNull();
    expect(mem.read(`deals/${dealOf(res.json).id as string}`)?.assignedToUid).toBeNull();
  });
});
