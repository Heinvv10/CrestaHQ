import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The mothership heartbeat receiver is unauthenticated by design (buyer
 * deployments hold no shared secret), so a per-IP limit is the only thing
 * standing between a script and an unbounded stream of Firestore writes and
 * new-instance alert emails.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/affiliate/instances-data", () => ({ sendNewInstanceAlert: vi.fn(async () => {}) }));

const { mem } = await import("@/test/gbp-sync-store");
const { POST } = await import("./route");

let n = 0;
const ping = (ip: string) =>
  POST(
    new Request("https://app.test/api/v1/leadstack/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ instanceId: `inst-${++n}`, ownerEmail: "o@example.com" }),
    }),
  );

beforeEach(() => mem.clear());

describe("POST /api/v1/leadstack/heartbeat rate limit", () => {
  it("429s one IP past its hourly budget without writing, while another IP still gets through", async () => {
    for (let i = 0; i < 30; i++) expect((await ping("198.51.100.20")).status).toBe(200);
    const writes = mem.list("leadstackInstances").length;
    const res = await ping("198.51.100.20");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(mem.list("leadstackInstances")).toHaveLength(writes);
    expect((await ping("198.51.100.21")).status).toBe(200);
  });
});
