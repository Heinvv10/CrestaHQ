import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { hashShareToken } from "@/lib/snapshots/share";

/**
 * Share + import routes through the REAL owner gate and share service over an
 * in-memory Firestore — the seam a service-only test cannot see (which agency
 * the route passes, what the response exposes).
 */

const mem = createMemoryFirestore();
const claims: Record<string, Record<string, unknown>> = {
  u_src: { status: "active", agencyId: "ag_src", agencyRole: "owner" },
  u_dst: { status: "active", agencyId: "ag_dst", agencyRole: "owner" },
  u_member: { status: "active", agencyId: "ag_dst", agencyRole: null },
};

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({ uid, customClaims: claims[uid] }),
  }),
}));

const { POST: createShare } = await import("./[snapshotId]/shares/route");
const { DELETE: revokeShare } = await import("./[snapshotId]/shares/[shareId]/route");
const { GET: listShares } = await import("./shares/route");
const { POST: importSnapshot } = await import("./import/route");
const { GET: listSnapshots } = await import("./route");

const req = (uid: string, method: string, body?: unknown) =>
  new Request("https://app.test/api/agency/snapshots", {
    method,
    headers: { "x-user-uid": uid },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function mintShare(body: Record<string, unknown> = {}) {
  return json(
    await createShare(req("u_src", "POST", body), {
      params: Promise.resolve({ snapshotId: "snap_1" }),
    }),
  );
}

const tokenOf = (url: unknown) => new URL(String(url)).searchParams.get("token")!;

beforeEach(() => {
  mem.clear();
  process.env.NEXT_PUBLIC_APP_URL = "https://crm.test/";
  mem.seed("agencies/ag_src/snapshots/snap_1", {
    id: "snap_1", agencyId: "ag_src", name: "Starter", description: "", version: 1,
    sourceSubAccountId: "sa_src", createdByUid: "u_src", createdAt: new Date(),
    payload: { forms: [], messageTemplates: [], products: [], workflows: [] },
  });
});

describe("snapshot share routes", () => {
  it("returns a link whose token is stored only as a hash, and imports it for another agency", async () => {
    const created = await mintShare({ expiresInDays: 30, singleUse: true });
    expect(created.status).toBe(200);
    const url = String(created.body.url);
    expect(url.startsWith("https://crm.test/agency/snapshots/import?token=")).toBe(true);
    const token = tokenOf(url);
    expect(mem.read(`snapshotShareIndex/${hashShareToken(token)}`)).toMatchObject({ agencyId: "ag_src" });

    const imported = await json(await importSnapshot(req("u_dst", "POST", { token })));
    expect(imported.status).toBe(200);
    expect(mem.read(`agencies/ag_dst/snapshots/${imported.body.snapshotId}`)).toMatchObject({
      agencyId: "ag_dst", createdByUid: "u_dst",
    });

    const list = await json(await listSnapshots(req("u_dst", "GET")));
    const rows = list.body.snapshots as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    // The memory store resolves serverTimestamp to a Date, so the millis is
    // null here; what matters is that the UI can tell the row is imported.
    expect(rows[0].importedFrom).toHaveProperty("importedAt");

    const again = await json(await importSnapshot(req("u_dst", "POST", { token })));
    expect(again).toEqual({ status: 404, body: { error: "Invalid or expired link" } });
  });

  it("refuses a non-owner importer and an out-of-range expiry", async () => {
    const { body } = await mintShare();
    const res = await importSnapshot(req("u_member", "POST", { token: tokenOf(body.url) }));
    expect(res.status).toBe(403);
    expect(mem.list("agencies/ag_dst/snapshots")).toHaveLength(0);
    expect((await mintShare({ expiresInDays: 90 })).status).toBe(400);
  });

  it("refuses with 409 to share a snapshot that was itself imported", async () => {
    mem.seed("agencies/ag_src/snapshots/snap_1", {
      id: "snap_1", agencyId: "ag_src", name: "Copy", version: 1, sourceSubAccountId: null,
      createdByUid: "u_src", createdAt: new Date(), importedFrom: { importedAt: new Date() },
      payload: { forms: [], messageTemplates: [], products: [], workflows: [] },
    });
    const res = await mintShare();
    expect(res.status).toBe(409);
    expect(mem.list("agencies/ag_src/snapshots/snap_1/shares")).toHaveLength(0);
  });

  it("refuses to mint when the app URL is unset, before writing anything", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect((await mintShare()).status).toBe(500);
    expect(mem.list("agencies/ag_src/snapshots/snap_1/shares")).toHaveLength(0);
  });

  it("lists shares for the owner's agency only, and a revoked link stops importing", async () => {
    const { body } = await mintShare();
    const shareId = (body.share as { id: string }).id;

    const other = await json(
      await revokeShare(req("u_dst", "DELETE"), {
        params: Promise.resolve({ snapshotId: "snap_1", shareId }),
      }),
    );
    expect(other.status).toBe(404);

    const revoked = await revokeShare(req("u_src", "DELETE"), {
      params: Promise.resolve({ snapshotId: "snap_1", shareId }),
    });
    expect(revoked.status).toBe(200);

    const shares = await json(await listShares(req("u_src", "GET")));
    expect(shares.body.shares).toEqual([expect.objectContaining({ id: shareId, status: "revoked" })]);
    expect(JSON.stringify(shares.body)).not.toContain("tokenHash");
    expect((await json(await listShares(req("u_dst", "GET")))).body.shares).toEqual([]);

    const res = await importSnapshot(req("u_dst", "POST", { token: tokenOf(body.url) }));
    expect(res.status).toBe(404);
  });
});
