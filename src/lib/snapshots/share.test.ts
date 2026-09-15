import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";
import {
  INVALID_LINK,
  createSnapshotShare,
  hashShareToken,
  importSharedSnapshot,
  listSnapshotShares,
  revokeSnapshotShare,
} from "./share";

const mem = createMemoryFirestore();
const db = mem.db as unknown as Firestore;

const SRC = "ag_src";
const DST = "ag_dst";
const SNAP = "snap_1";
const T0 = new Date("2026-09-15T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** A stored snapshot with source-tenant ids planted where capture does not look. */
function seedSnapshot() {
  mem.seed(`agencies/${SRC}/snapshots/${SNAP}`, {
    id: SNAP,
    agencyId: SRC,
    name: "Plumber starter",
    description: "d",
    version: 1,
    sourceSubAccountId: "sa_src",
    createdByUid: "u_src_owner",
    createdAt: T0,
    payload: {
      forms: [{ sourceId: "f1", name: "Lead", config: { subAccountId: "sa_sibling", owner: "u_src_owner" } }],
      messageTemplates: [],
      products: [{ sourceId: "p1", name: "Call-out", note: "ag_src" }],
      workflows: [
        {
          sourceId: "w1",
          name: "Assign",
          trigger: { type: "form_submitted", formId: "f1" },
          nodes: {
            n1: { id: "n1", type: "create_task", config: { title: "Call", assignedToUid: "u_src_member" } },
          },
        },
      ],
      customFields: [],
      aiProfile: null,
    },
  });
}

async function share(opts: { singleUse?: boolean; days?: 1 | 7 | 30 } = {}) {
  const out = await createSnapshotShare(db, {
    agencyId: SRC,
    snapshotId: SNAP,
    uid: "u_src_owner",
    expiresInDays: opts.days ?? 7,
    singleUse: opts.singleUse ?? false,
    now: T0,
  });
  if (!out) throw new Error("share not created");
  return out;
}

const importAs = (token: string, agencyId = DST, now = T0) =>
  importSharedSnapshot(db, { token, agencyId, uid: "u_dst_owner", now });

beforeEach(() => {
  mem.clear();
  seedSnapshot();
});

describe("createSnapshotShare", () => {
  it("stores only the token's hash, on the share and as the index key", async () => {
    const { share: s, token } = await share();
    const stored = mem.read(`agencies/${SRC}/snapshots/${SNAP}/shares/${s.id}`)!;
    expect(stored.tokenHash).toBe(hashShareToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored).toMatchObject({ agencyId: SRC, createdByUid: "u_src_owner", usedCount: 0, revokedAt: null });
    const index = mem.read(`snapshotShareIndex/${hashShareToken(token)}`)!;
    expect(index).toMatchObject({ agencyId: SRC, snapshotId: SNAP, shareId: s.id, createdByUid: "u_src_owner" });
    expect(JSON.stringify(index)).not.toContain(token);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("refuses a snapshot that is not in the caller's agency", async () => {
    const out = await createSnapshotShare(db, {
      agencyId: DST, snapshotId: SNAP, uid: "u", expiresInDays: 7, singleUse: false, now: T0,
    });
    expect(out).toBeNull();
    expect(mem.list(`agencies/${DST}/snapshots/${SNAP}/shares`)).toHaveLength(0);
  });
});

describe("importSharedSnapshot", () => {
  it("creates a copy in the importer's agency with provenance and no source tenancy", async () => {
    const { share: s, token } = await share();
    const out = await importAs(token);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const doc = mem.read(`agencies/${DST}/snapshots/${out.snapshotId}`)!;
    expect(doc).toMatchObject({
      id: out.snapshotId,
      agencyId: DST,
      createdByUid: "u_dst_owner",
      name: "Plumber starter",
      sourceSubAccountId: null,
      importedFrom: { agencyId: SRC, snapshotId: SNAP, shareId: s.id },
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { importedFrom, ...rest } = doc;
    const body = JSON.stringify(rest);
    // sa_sibling is a source sub-account the scrub has no id for — only its
    // `subAccountId` key gives it away.
    for (const sourceId of ["ag_src", "sa_src", "sa_sibling", "u_src_owner", "u_src_member"]) {
      expect(body, `imported doc leaks ${sourceId}`).not.toContain(sourceId);
    }
    // The config itself survives the scrub.
    expect(body).toContain("Call-out");
    expect(body).toContain('"formId":"f1"');
  });

  it("refuses an import into the agency that owns the snapshot", async () => {
    const { token } = await share();
    expect(await importAs(token, SRC)).toEqual({ ok: false, status: 409, error: expect.any(String) });
    expect(mem.list(`agencies/${SRC}/snapshots`)).toHaveLength(1);
  });

  it("refuses an unknown token", async () => {
    expect(await importAs("not-a-token")).toEqual({ ok: false, status: 404, error: INVALID_LINK });
  });

  it("refuses an expired link", async () => {
    const { token } = await share({ days: 1 });
    expect(await importAs(token, DST, new Date(T0.getTime() + DAY - 1))).toMatchObject({ ok: true });
    expect(await importAs(token, DST, new Date(T0.getTime() + DAY))).toEqual({
      ok: false, status: 404, error: INVALID_LINK,
    });
  });

  it("counts every use, and refuses the second import of a single-use link", async () => {
    const { share: s, token } = await share({ singleUse: true });
    const sharePath = `agencies/${SRC}/snapshots/${SNAP}/shares/${s.id}`;
    expect(await importAs(token)).toMatchObject({ ok: true });
    expect(mem.read(sharePath)!.usedCount).toBe(1);
    expect(await importAs(token, "ag_third")).toEqual({ ok: false, status: 404, error: INVALID_LINK });
    expect(mem.list("agencies/ag_third/snapshots")).toHaveLength(0);
    expect(mem.read(sharePath)!.usedCount).toBe(1);
  });

  it("refuses a live link whose source snapshot is gone", async () => {
    const { token } = await share();
    await mem.db.doc(`agencies/${SRC}/snapshots/${SNAP}`).delete();
    expect(await importAs(token)).toEqual({ ok: false, status: 404, error: INVALID_LINK });
    expect(mem.list(`agencies/${DST}/snapshots`)).toHaveLength(0);
  });

  it("lets a multi-use link import more than once", async () => {
    const { share: s, token } = await share();
    expect(await importAs(token)).toMatchObject({ ok: true });
    expect(await importAs(token, "ag_third")).toMatchObject({ ok: true });
    expect(mem.read(`agencies/${SRC}/snapshots/${SNAP}/shares/${s.id}`)!.usedCount).toBe(2);
  });
});

describe("revokeSnapshotShare", () => {
  it("marks the share revoked, deletes its index entry, and import is refused", async () => {
    const { share: s, token } = await share();
    const ok = await revokeSnapshotShare(db, { agencyId: SRC, snapshotId: SNAP, shareId: s.id, now: T0 });
    expect(ok).toBe(true);
    expect(mem.read(`agencies/${SRC}/snapshots/${SNAP}/shares/${s.id}`)!.revokedAt).not.toBeNull();
    expect(mem.read(`snapshotShareIndex/${hashShareToken(token)}`)).toBeUndefined();
    expect(await importAs(token)).toEqual({ ok: false, status: 404, error: INVALID_LINK });
  });

  it("refuses a revoked share even if its index entry survived", async () => {
    const { share: s, token } = await share();
    const indexPath = `snapshotShareIndex/${hashShareToken(token)}`;
    const index = mem.read(indexPath)!;
    await revokeSnapshotShare(db, { agencyId: SRC, snapshotId: SNAP, shareId: s.id, now: T0 });
    mem.seed(indexPath, index);
    expect(await importAs(token)).toEqual({ ok: false, status: 404, error: INVALID_LINK });
  });

  it("returns false for a share outside the caller's agency", async () => {
    const { share: s } = await share();
    expect(await revokeSnapshotShare(db, { agencyId: DST, snapshotId: SNAP, shareId: s.id })).toBe(false);
  });
});

describe("listSnapshotShares", () => {
  it("lists the agency's shares with a status and without the hash", async () => {
    const { share: a } = await share({ singleUse: true });
    const { share: b } = await share();
    await revokeSnapshotShare(db, { agencyId: SRC, snapshotId: SNAP, shareId: b.id, now: T0 });
    const list = await listSnapshotShares(db, SRC, T0);
    expect(list.map((s) => [s.id, s.status]).sort()).toEqual([[a.id, "active"], [b.id, "revoked"]].sort());
    expect(JSON.stringify(list)).not.toContain("tokenHash");
    expect(await listSnapshotShares(db, DST, T0)).toEqual([]);
  });
});
