import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { createSnapshotShare, revokeSnapshotShare } from "@/lib/snapshots/share";

/**
 * The public snapshot download, through the real share service over an
 * in-memory Firestore: what the file carries, how it is served, and that a
 * bad link is refused without saying why.
 */

const mem = createMemoryFirestore();
const db = mem.db as unknown as Firestore;
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const { GET } = await import("./route");

const get = (token: string) =>
  GET(new Request(`https://app.test/api/public/snapshots/${token}`), {
    params: Promise.resolve({ token }),
  });

async function mint(singleUse: boolean) {
  const out = await createSnapshotShare(db, {
    agencyId: "ag_src", snapshotId: "snap_1", uid: "u_src", expiresInDays: 7, singleUse,
  });
  if (typeof out === "string") throw new Error(out);
  return out;
}

beforeEach(() => {
  mem.clear();
  mem.seed("agencies/ag_src/snapshots/snap_1", {
    id: "snap_1", agencyId: "ag_src", name: "Plumber Starter!", version: 1,
    sourceSubAccountId: "sa_src_Y", createdByUid: "u_src", createdAt: new Date(),
    payload: {
      forms: [{ sourceId: "form_src_X", name: "Lead", settings: { redirectUrl: "https://source.example/thanks" } }],
      messageTemplates: [], products: [], customFields: [], aiProfile: null,
      workflows: [{
        sourceId: "wf_src_Z", name: "Flow",
        trigger: { type: "form.submitted", filters: { all: [] }, formId: "form_src_X" },
        nodes: {
          n1: { id: "n1", type: "notify", config: { recipient: "custom", to: "leak@source.example", subject: "s", body: "b" } },
          n2: { id: "n2", type: "webhook", config: { url: "https://source.example/hook" } },
        },
      }],
    },
  });
});

describe("GET /api/public/snapshots/[token]", () => {
  it("serves a portable, uncacheable attachment with nothing that points back at the source", async () => {
    const { share, token } = await mint(false);
    const res = await get(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="plumber-starter.leadstack-snapshot.json"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();

    const text = await res.text();
    const file = JSON.parse(text) as Record<string, unknown>;
    expect(file).toMatchObject({ format: "leadstack-snapshot", version: 1, name: "Plumber Starter!" });
    for (const leak of ["ag_src", "sa_src_Y", "u_src", "form_src_X", "wf_src_Z", "leak@source.example", "source.example/hook", "source.example/thanks"]) {
      expect(text, `file carries ${leak}`).not.toContain(leak);
    }
    expect(mem.read(`agencies/ag_src/snapshots/snap_1/shares/${share.id}`)!.usedCount).toBe(1);
  });

  it("downloads a single-use link once, then refuses with the uniform 404", async () => {
    const { token } = await mint(true);
    expect((await get(token)).status).toBe(200);
    const again = await get(token);
    expect(again.status).toBe(404);
    expect(again.headers.get("cache-control")).toBe("no-store");
    expect(await again.json()).toEqual({ error: "Invalid or expired link" });
  });

  it("refuses an unknown and a revoked token alike", async () => {
    expect((await get("nope")).status).toBe(404);
    const { share, token } = await mint(false);
    await revokeSnapshotShare(db, { agencyId: "ag_src", snapshotId: "snap_1", shareId: share.id });
    expect((await get(token)).status).toBe(404);
  });
});
