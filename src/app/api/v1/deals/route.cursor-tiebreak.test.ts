import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { mintApiKey } from "@/lib/api/keys";

/**
 * GET /api/v1/deals — cursor pagination must tiebreak docs that share a
 * `stageChangedAt`. Bulk import writes up to 400 deals per batch under ONE
 * `serverTimestamp`, so without a tiebreaker a page boundary landing mid-tie
 * either skips or repeats a deal.
 */

const mem = createMemoryFirestore();

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => {} }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const { GET } = await import("./route");

let key = "";

async function list(qs = ""): Promise<{ status: number; json: { data: Array<{ id: string }>; has_more: boolean } }> {
  const res = await GET(
    new Request(`https://app.test/api/v1/deals${qs}`, {
      headers: { authorization: `Bearer ${key}` },
    }),
    { params: Promise.resolve({}) },
  );
  return { status: res.status, json: (await res.json()) as never };
}

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { name: "SA", agencyId: "ag1", apiAccessEnabledByAgency: true });
  const k = mintApiKey("live");
  mem.seed("subAccounts/sa1/apiKeys/key1", {
    subAccountId: "sa1", agencyId: "ag1", name: "k", mode: "live", prefix: k.prefix,
    hashedSecret: k.hashedSecret, scopes: ["admin"], revokedAt: null,
  });
  key = k.rawKey;
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann" });

  // Five deals sharing one stageChangedAt, as a bulk-import batch would write.
  const tied = new Date("2026-01-01T00:00:00.000Z");
  for (const id of ["d1", "d2", "d3", "d4", "d5"]) {
    mem.seed(`deals/${id}`, {
      title: id, contactId: "c1", stageId: "new", subAccountId: "sa1", agencyId: "ag1",
      mode: "live", stageChangedAt: tied, createdAt: tied,
    });
  }
});

describe("GET /api/v1/deals — cursor tiebreak", () => {
  it("returns every tied deal exactly once when paging through with limit=2", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const qs = cursor ? `?limit=2&starting_after=${cursor}` : "?limit=2";
      const { status, json } = await list(qs);
      expect(status).toBe(200);
      seen.push(...json.data.map((d) => d.id));
      if (!json.has_more) break;
      cursor = json.data[json.data.length - 1]!.id;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual(["d1", "d2", "d3", "d4", "d5"]);
  });
});
