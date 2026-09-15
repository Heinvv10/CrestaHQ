import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A tiny Firestore + bucket fake: docs in a Map, objects in a Map. The
 * assertions that matter are the refusals (foreign prefix, forged URL,
 * non-empty folder) and that size/contentType come from the BUCKET.
 */
const fake = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  objects: new Map<string, { size: string; contentType: string }>(),
  deletedObjects: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "ts" },
}));
vi.mock("@/lib/firebase/admin", () => {
  const docRef = (path: string) => ({
    id: path.split("/").pop()!,
    get: async () => ({ exists: fake.docs.has(path), data: () => fake.docs.get(path) }),
    set: async (d: Record<string, unknown>) => void fake.docs.set(path, { ...d }),
    update: async (d: Record<string, unknown>) => {
      if (!fake.docs.has(path)) throw new Error("NOT_FOUND");
      fake.docs.set(path, { ...fake.docs.get(path)!, ...d });
    },
    delete: async () => void fake.docs.delete(path),
  });
  let auto = 0;
  const query = (path: string, filters: Array<[string, unknown]>) => ({
    where: (f: string, _op: string, v: unknown) => query(path, [...filters, [f, v]]),
    limit: () => query(path, filters),
    get: async () => {
      const docs = [...fake.docs.entries()]
        .filter(([p]) => p.slice(0, p.lastIndexOf("/")) === path)
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v));
      return { empty: docs.length === 0, size: docs.length };
    },
    doc: (id?: string) => docRef(`${path}/${id ?? `auto_${++auto}`}`),
  });
  const file = (path: string) => ({
    exists: async () => [fake.objects.has(path)],
    getMetadata: async () => [fake.objects.get(path) ?? {}],
    delete: async () => void (fake.deletedObjects.push(path), fake.objects.delete(path)),
  });
  return {
    getAdminDb: () => ({ doc: docRef, collection: (p: string) => query(p, []) }),
    getAdminStorage: () => ({ bucket: () => ({ file }) }),
  };
});

import {
  MediaError,
  createMediaAsset,
  deleteMediaAsset,
  deleteMediaFolder,
} from "./service";

const SA = "sa_1";
const PATH = `media/${SA}/m1/logo.png`;
const url = (p: string) =>
  `https://firebasestorage.googleapis.com/v0/b/bkt/o/${encodeURIComponent(p)}?alt=media&token=t`;
const base = { subAccountId: SA, agencyId: "ag_1", uid: "u1" };
const body = (patch: Record<string, unknown> = {}) => ({
  mediaId: "m1",
  name: "Logo",
  storagePath: PATH,
  downloadUrl: url(PATH),
  contentType: "text/html",
  size: 1,
  folderId: null,
  ...patch,
});

beforeEach(() => {
  fake.docs.clear();
  fake.objects.clear();
  fake.deletedObjects.length = 0;
  fake.objects.set(PATH, { size: "12345", contentType: "image/png" });
});

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof MediaError) return e.status;
    throw e;
  }
};

describe("createMediaAsset", () => {
  it("stores the bucket's size + contentType, never the body's", async () => {
    const asset = await createMediaAsset({ ...base, body: body() });
    expect(asset.size).toBe(12345);
    expect(asset.contentType).toBe("image/png");
    expect(asset.kind).toBe("image");
    expect(fake.docs.get(`subAccounts/${SA}/media/m1`)).toMatchObject({
      size: 12345,
      contentType: "image/png",
      agencyId: "ag_1",
      subAccountId: SA,
      createdByUid: "u1",
    });
  });

  it("refuses a storagePath outside media/{sa}/{mediaId}/", async () => {
    const other = `media/sa_2/m1/logo.png`;
    fake.objects.set(other, { size: "1", contentType: "image/png" });
    expect(
      await status(createMediaAsset({ ...base, body: body({ storagePath: other, downloadUrl: url(other) }) })),
    ).toBe(400);
    const nested = `media/${SA}/m1/a/b.png`;
    fake.objects.set(nested, { size: "1", contentType: "image/png" });
    expect(
      await status(createMediaAsset({ ...base, body: body({ storagePath: nested, downloadUrl: url(nested) }) })),
    ).toBe(400);
    expect(fake.docs.size).toBe(0);
  });

  it("refuses a downloadUrl that does not point at this object", async () => {
    expect(
      await status(createMediaAsset({ ...base, body: body({ downloadUrl: "https://evil.example/x.png" }) })),
    ).toBe(400);
    expect(
      await status(createMediaAsset({ ...base, body: body({ downloadUrl: url(`media/sa_2/m1/logo.png`) }) })),
    ).toBe(400);
    expect(fake.docs.size).toBe(0);
  });

  it("404s when the object was never uploaded, 409s a duplicate", async () => {
    fake.objects.delete(PATH);
    expect(await status(createMediaAsset({ ...base, body: body() }))).toBe(404);
    fake.objects.set(PATH, { size: "1", contentType: "image/png" });
    await createMediaAsset({ ...base, body: body() });
    expect(await status(createMediaAsset({ ...base, body: body() }))).toBe(409);
  });

  it("deletes and refuses an object the bucket says is a disallowed type", async () => {
    fake.objects.set(PATH, { size: "5", contentType: "text/html" });
    expect(await status(createMediaAsset({ ...base, body: body() }))).toBe(400);
    expect(fake.deletedObjects).toEqual([PATH]);
    expect(fake.docs.size).toBe(0);
  });

  it("requires a name and an existing folder", async () => {
    expect(await status(createMediaAsset({ ...base, body: body({ name: "  " }) }))).toBe(400);
    expect(await status(createMediaAsset({ ...base, body: body({ folderId: "nope" }) }))).toBe(404);
    fake.docs.set(`subAccounts/${SA}/mediaFolders/f1`, { name: "F", parentId: null });
    const asset = await createMediaAsset({ ...base, body: body({ folderId: "f1" }) });
    expect(asset.folderId).toBe("f1");
  });
});

describe("deleteMediaAsset", () => {
  it("removes the object then the doc; a missing object is fine", async () => {
    await createMediaAsset({ ...base, body: body() });
    fake.objects.delete(PATH);
    await deleteMediaAsset(SA, "m1");
    expect(fake.deletedObjects).toEqual([PATH]);
    expect(fake.docs.has(`subAccounts/${SA}/media/m1`)).toBe(false);
  });
});

describe("deleteMediaFolder", () => {
  beforeEach(() => {
    fake.docs.set(`subAccounts/${SA}/mediaFolders/f1`, { name: "F", parentId: null });
  });

  it("refuses while a file is inside", async () => {
    fake.docs.set(`subAccounts/${SA}/media/x`, { folderId: "f1" });
    expect(await status(deleteMediaFolder(SA, "f1"))).toBe(409);
    expect(fake.docs.has(`subAccounts/${SA}/mediaFolders/f1`)).toBe(true);
  });

  it("refuses while a sub-folder is inside", async () => {
    fake.docs.set(`subAccounts/${SA}/mediaFolders/f2`, { name: "G", parentId: "f1" });
    expect(await status(deleteMediaFolder(SA, "f1"))).toBe(409);
  });

  it("deletes an empty folder", async () => {
    await deleteMediaFolder(SA, "f1");
    expect(fake.docs.has(`subAccounts/${SA}/mediaFolders/f1`)).toBe(false);
  });
});
