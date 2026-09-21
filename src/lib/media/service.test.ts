import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "ts" },
}));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/media-fake")).mediaAdminMock());

import { downloadUrl, mediaFake as fake, resetMediaFake } from "@/test/media-fake";
import {
  MediaError,
  createMediaAsset,
  createMediaFolder,
  deleteMediaAsset,
  deleteMediaFolder,
  updateMediaAsset,
  updateMediaFolder,
} from "./service";

/**
 * The assertions that matter are the refusals (foreign prefix, forged URL,
 * non-empty folder, malformed ids) and that size/contentType come from the
 * BUCKET.
 */

const SA = "sa_1";
const PATH = `media/${SA}/m1/logo.png`;
const base = { subAccountId: SA, agencyId: "ag_1", uid: "u1" };
const body = (patch: Record<string, unknown> = {}) => ({
  mediaId: "m1",
  name: "Logo",
  storagePath: PATH,
  downloadUrl: downloadUrl(PATH),
  contentType: "text/html",
  size: 1,
  folderId: null,
  ...patch,
});
const FOLDER = `subAccounts/${SA}/mediaFolders/f1`;
const MEDIA = `subAccounts/${SA}/media/m1`;

beforeEach(() => {
  resetMediaFake();
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
    expect(fake.docs.get(MEDIA)).toMatchObject({
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
      await status(createMediaAsset({ ...base, body: body({ storagePath: other, downloadUrl: downloadUrl(other) }) })),
    ).toBe(400);
    const nested = `media/${SA}/m1/a/b.png`;
    fake.objects.set(nested, { size: "1", contentType: "image/png" });
    expect(
      await status(createMediaAsset({ ...base, body: body({ storagePath: nested, downloadUrl: downloadUrl(nested) }) })),
    ).toBe(400);
    expect(fake.docs.size).toBe(0);
  });

  it("refuses a downloadUrl that does not point at this object in our bucket", async () => {
    for (const forged of [
      "https://evil.example/x.png",
      downloadUrl(`media/sa_2/m1/logo.png`),
      downloadUrl(PATH, "someone-elses-bucket"),
    ]) {
      expect(await status(createMediaAsset({ ...base, body: body({ downloadUrl: forged }) })), forged).toBe(400);
    }
    expect(fake.docs.size).toBe(0);
  });

  it("refuses a malformed mediaId", async () => {
    expect(await status(createMediaAsset({ ...base, body: body({ mediaId: "../x" }) }))).toBe(400);
    expect(await status(createMediaAsset({ ...base, body: body({ mediaId: undefined }) }))).toBe(400);
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
    fake.docs.set(FOLDER, { name: "F", parentId: null });
    const asset = await createMediaAsset({ ...base, body: body({ folderId: "f1" }) });
    expect(asset.folderId).toBe("f1");
  });
});

describe("updateMediaAsset", () => {
  beforeEach(() => {
    fake.docs.set(MEDIA, { name: "Logo", folderId: null, storagePath: PATH });
  });

  it("404s a missing file and a malformed id", async () => {
    expect(await status(updateMediaAsset(SA, "nope", { name: "X" }))).toBe(404);
    fake.reads.length = 0;
    expect(await status(updateMediaAsset(SA, "a/b", { name: "X" }))).toBe(404);
    expect(fake.reads).toEqual([]);
  });

  it("renames, refusing a blank or over-long name", async () => {
    await updateMediaAsset(SA, "m1", { name: "  New name  " });
    expect(fake.docs.get(MEDIA)?.name).toBe("New name");
    expect(await status(updateMediaAsset(SA, "m1", { name: "" }))).toBe(400);
    expect(await status(updateMediaAsset(SA, "m1", { name: "x".repeat(121) }))).toBe(400);
    expect(fake.docs.get(MEDIA)?.name).toBe("New name");
  });

  it("moves into an existing folder and back to root; 404s a missing folder", async () => {
    expect(await status(updateMediaAsset(SA, "m1", { folderId: "f1" }))).toBe(404);
    expect(fake.docs.get(MEDIA)?.folderId).toBeNull();
    fake.docs.set(FOLDER, { name: "F", parentId: null });
    await updateMediaAsset(SA, "m1", { folderId: "f1" });
    expect(fake.docs.get(MEDIA)?.folderId).toBe("f1");
    await updateMediaAsset(SA, "m1", { folderId: null });
    expect(fake.docs.get(MEDIA)?.folderId).toBeNull();
  });
});

describe("deleteMediaAsset", () => {
  it("removes the object then the doc; a missing object is fine", async () => {
    await createMediaAsset({ ...base, body: body() });
    fake.objects.delete(PATH);
    await deleteMediaAsset(SA, "m1");
    expect(fake.deletedObjects).toEqual([PATH]);
    expect(fake.docs.has(MEDIA)).toBe(false);
  });

  it("404s a missing file and a malformed id without touching the bucket", async () => {
    expect(await status(deleteMediaAsset(SA, "nope"))).toBe(404);
    fake.reads.length = 0;
    expect(await status(deleteMediaAsset(SA, "a/b"))).toBe(404);
    expect(fake.reads).toEqual([]);
    expect(fake.deletedObjects).toEqual([]);
  });
});

describe("createMediaFolder", () => {
  it("creates with tenancy keys; refuses a bad name and a missing parent", async () => {
    expect(await status(createMediaFolder({ ...base, body: { name: " " } }))).toBe(400);
    expect(await status(createMediaFolder({ ...base, body: { name: "A", parentId: "nope" } }))).toBe(404);
    expect(await status(createMediaFolder({ ...base, body: { name: "A", parentId: 7 } }))).toBe(400);
    expect(fake.docs.size).toBe(0);
    const id = await createMediaFolder({ ...base, body: { name: "  Brand  " } });
    expect(fake.docs.get(`subAccounts/${SA}/mediaFolders/${id}`)).toMatchObject({
      name: "Brand",
      parentId: null,
      agencyId: "ag_1",
      subAccountId: SA,
      createdByUid: "u1",
    });
  });
});

describe("updateMediaFolder", () => {
  it("renames; 404s a missing folder and a malformed id", async () => {
    fake.docs.set(FOLDER, { name: "F", parentId: null });
    await updateMediaFolder(SA, "f1", { name: "G" });
    expect(fake.docs.get(FOLDER)?.name).toBe("G");
    expect(await status(updateMediaFolder(SA, "nope", { name: "G" }))).toBe(404);
    fake.reads.length = 0;
    expect(await status(updateMediaFolder(SA, "f/1", { name: "G" }))).toBe(404);
    expect(fake.reads).toEqual([]);
  });
});

describe("deleteMediaFolder", () => {
  beforeEach(() => {
    fake.docs.set(FOLDER, { name: "F", parentId: null });
  });

  it("refuses while a file is inside", async () => {
    fake.docs.set(`subAccounts/${SA}/media/x`, { folderId: "f1" });
    expect(await status(deleteMediaFolder(SA, "f1"))).toBe(409);
    expect(fake.docs.has(FOLDER)).toBe(true);
  });

  it("refuses while a sub-folder is inside", async () => {
    fake.docs.set(`subAccounts/${SA}/mediaFolders/f2`, { name: "G", parentId: "f1" });
    expect(await status(deleteMediaFolder(SA, "f1"))).toBe(409);
  });

  it("deletes an empty folder; 404s a missing one and a malformed id", async () => {
    expect(await status(deleteMediaFolder(SA, "nope"))).toBe(404);
    fake.reads.length = 0;
    expect(await status(deleteMediaFolder(SA, "f/1"))).toBe(404);
    expect(fake.reads).toEqual([]);
    await deleteMediaFolder(SA, "f1");
    expect(fake.docs.has(FOLDER)).toBe(false);
  });
});
