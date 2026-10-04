import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agency PATCH `brandColor` (prospect report redesign R2): rejected at save
 * unless white text on it reaches WCAG AA (4.5:1), on the real route over
 * an in-memory Firestore, callers identified via `x-user-uid` like middleware.
 */

const mem = vi.hoisted(() => ({ ref: null as ReturnType<typeof import("@/test/memory-firestore").createMemoryFirestore> | null }));
const claims: Record<string, Record<string, unknown>> = {
  owner1: { status: "active", agencyId: "ag1", agencyRole: "owner" },
  staff1: { status: "active", agencyId: "ag1", agencyRole: "staff" },
};
vi.mock("@/lib/firebase/admin", async () => {
  const { createMemoryFirestore: make } = await import("@/test/memory-firestore");
  mem.ref = make();
  return {
    getAdminDb: () => mem.ref!.db,
    getAdminAuth: () => ({ getUser: async (uid: string) => (claims[uid] ? { customClaims: claims[uid] } : null) }),
  };
});
vi.mock("@/lib/agency/policy", () => ({ invalidateAgencyPolicyCache: vi.fn() }));

const { PATCH } = await import("./route");
const db = () => mem.ref!;

const patch = (uid: string, body: unknown) =>
  PATCH(
    new Request("http://x/api/agency", {
      method: "PATCH",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  db().clear();
  db().seed("agencies/ag1", { name: "Cresta Agency", ownerUid: "owner1" });
});

describe("brandColor", () => {
  it("accepts a colour that clears WCAG AA contrast", async () => {
    const res = await patch("owner1", { brandColor: "#2563EB" });
    expect(res.status).toBe(200);
    expect(db().read("agencies/ag1")).toMatchObject({ brandColor: "#2563EB" });
  });

  it("rejects a pale colour with the measured ratio in the error", async () => {
    const res = await patch("owner1", { brandColor: "#FFFF00" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/1\.07:1/);
    expect(db().read("agencies/ag1")).not.toHaveProperty("brandColor");
  });

  it("rejects a malformed hex value", async () => {
    const res = await patch("owner1", { brandColor: "blue" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringMatching(/hex/) });
  });

  it("clears brandColor with null", async () => {
    db().seed("agencies/ag1", { name: "Cresta Agency", ownerUid: "owner1", brandColor: "#2563EB" });
    const res = await patch("owner1", { brandColor: null });
    expect(res.status).toBe(200);
    expect(db().read("agencies/ag1")).toMatchObject({ brandColor: null });
  });

  it("refuses a non-owner", async () => {
    const res = await patch("staff1", { brandColor: "#2563EB" });
    expect(res.status).toBe(403);
  });
});

describe("agentApiEnabled (Agency Agent API kill switch)", () => {
  beforeEach(() => {
    db().seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "active" });
  });

  it("the owner switches it on and off", async () => {
    expect((await patch("owner1", { agentApiEnabled: true })).status).toBe(200);
    expect(db().read("agencies/ag1")).toMatchObject({ agentApiEnabled: true });
    expect((await patch("owner1", { agentApiEnabled: false })).status).toBe(200);
    expect(db().read("agencies/ag1")).toMatchObject({ agentApiEnabled: false });
  });

  it("rejects a non-boolean", async () => {
    expect((await patch("owner1", { agentApiEnabled: "yes" })).status).toBe(400);
    expect(db().read("agencies/ag1")).not.toHaveProperty("agentApiEnabled");
  });

  it("refuses staff", async () => {
    expect((await patch("staff1", { agentApiEnabled: true })).status).toBe(403);
    expect(db().read("agencies/ag1")).not.toHaveProperty("agentApiEnabled");
  });

  // PR #346 review, breaker REPRO 2: the owner claim outlives a removal.
  it("refuses an owner whose agencyMembers row is removed, though the claim still says owner", async () => {
    db().seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "removed" });
    expect((await patch("owner1", { agentApiEnabled: true })).status).toBe(403);
    expect(db().read("agencies/ag1")).not.toHaveProperty("agentApiEnabled");
  });
});
