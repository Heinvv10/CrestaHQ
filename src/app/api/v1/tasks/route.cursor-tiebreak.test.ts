import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { mintApiKey } from "@/lib/api/keys";

/**
 * GET /api/v1/tasks — cursor pagination must tiebreak docs that share a
 * `createdAt`. Bulk import writes up to 400 tasks per batch under ONE
 * `serverTimestamp`, so without a tiebreaker a page boundary landing mid-tie
 * either skips or repeats a task.
 */

const mem = createMemoryFirestore();

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => {} }));

const { GET } = await import("./route");

let key = "";

async function list(qs = ""): Promise<{ status: number; json: { data: Array<{ id: string }>; has_more: boolean } }> {
  const res = await GET(
    new Request(`https://app.test/api/v1/tasks${qs}`, {
      headers: { authorization: `Bearer ${key}` },
    }),
    { params: undefined },
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

  // Five tasks sharing one createdAt, as a bulk-import batch would write.
  const tied = new Date("2026-01-01T00:00:00.000Z");
  for (const id of ["t1", "t2", "t3", "t4", "t5"]) {
    mem.seed(`tasks/${id}`, {
      title: id, completed: false, subAccountId: "sa1", agencyId: "ag1", mode: "live", createdAt: tied,
    });
  }
});

describe("GET /api/v1/tasks — cursor tiebreak", () => {
  it("returns every tied task exactly once when paging through with limit=2", async () => {
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
    expect(seen.sort()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });
});
