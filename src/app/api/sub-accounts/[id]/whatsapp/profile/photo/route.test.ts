import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Objects in the fake bucket, by storage path. */
const bucket = vi.hoisted(() => ({ objects: new Map<string, Uint8Array>(), downloads: [] as string[] }));

vi.mock("@/lib/firebase/admin", async () => ({
  ...(await import("@/test/google-oauth-harness")).adminMock(),
  getAdminStorage: () => ({
    bucket: () => ({
      file: (path: string) => ({
        download: async () => {
          bucket.downloads.push(path);
          const bytes = bucket.objects.get(path);
          if (!bytes) throw new Error(`No such object: ${path}`);
          return [Buffer.from(bytes)];
        },
      }),
    }),
  }),
}));

import { ORIGINAL_ENV, OTHER_SUB, SUB, call, json, resetWaSettings, scenario, state } from "@/test/wa-settings-harness";
import { MAX_PHOTO_BYTES, sniffPhotoMime } from "@/lib/comms/whatsapp/settings/photo";
import { POST } from "./route";

/** POST /whatsapp/profile/photo — bytes decide the type, admin only. */

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function form(bytes: Uint8Array, contentType = "image/jpeg", field = "file"): FormData {
  const fd = new FormData();
  fd.append(field, new Blob([bytes as BlobPart], { type: contentType }), "photo.bin");
  return fd;
}

beforeEach(() => {
  resetWaSettings();
  bucket.objects.clear();
  bucket.downloads = [];
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("sniffPhotoMime", () => {
  it("recognises JPEG and PNG by magic bytes only", () => {
    expect(sniffPhotoMime(JPEG)).toBe("image/jpeg");
    expect(sniffPhotoMime(PNG)).toBe("image/png");
    expect(sniffPhotoMime(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull(); // GIF
    expect(sniffPhotoMime(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeNull(); // <svg
    expect(sniffPhotoMime(new Uint8Array([]))).toBeNull();
  });
});

describe("POST", () => {
  it("an admin uploads a JPEG and gets the new picture URL", async () => {
    const { status, body } = await json(call(POST, { id: SUB }, { method: "POST", raw: form(JPEG) }));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(String(body.profilePictureUrl)).toMatch(/^data:image\/jpeg;base64,/);
    expect(scenario()?.calls).toEqual([{ op: "uploadProfilePhoto", arg: `image/jpeg:${JPEG.byteLength}` }]);
  });

  it("uses the sniffed type, not the client's content-type", async () => {
    const { status, body } = await json(call(POST, { id: SUB }, { method: "POST", raw: form(PNG, "image/jpeg") }));
    expect(status).toBe(200);
    expect(String(body.profilePictureUrl)).toMatch(/^data:image\/png;base64,/);
  });

  it("400s a non-image claiming to be one, and a missing file field", async () => {
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const { status, body } = await json(call(POST, { id: SUB }, { method: "POST", raw: form(svg, "image/png") }));
    expect(status).toBe(400);
    expect(body.error).toMatch(/JPEG or PNG/);
    expect((await call(POST, { id: SUB }, { method: "POST", raw: form(JPEG, "image/jpeg", "photo") })).status).toBe(400);
    expect((await call(POST, { id: SUB }, { method: "POST", body: { file: "x" } })).status).toBe(400);
    expect(scenario()).toBeUndefined();
  });

  it("400s a photo over 5 MB without reading it into the provider", async () => {
    const big = new Uint8Array(MAX_PHOTO_BYTES + 1);
    big.set(JPEG);
    const { status, body } = await json(call(POST, { id: SUB }, { method: "POST", raw: form(big) }));
    expect(status).toBe(400);
    expect(body.error).toMatch(/5 MB/);
    expect(scenario()).toBeUndefined();
  });

  it("403s a member, and a gated-off workspace", async () => {
    expect((await call(POST, { id: SUB }, { uid: "uid_member", method: "POST", raw: form(JPEG) })).status).toBe(403);
    resetWaSettings({ gateOn: false });
    expect((await call(POST, { id: SUB }, { method: "POST", raw: form(JPEG) })).status).toBe(403);
    expect(scenario()).toBeUndefined();
  });
});

describe("the body is not read before the caller is known", () => {
  it("an unauthenticated POST with a body that would fail validation gets 401, not 400", async () => {
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const res = await call(POST, { id: SUB }, { uid: null, method: "POST", raw: form(svg, "image/png") });
    expect(res.status).toBe(401);
    // A member with a bad body is refused on role, not on the body.
    const member = await call(POST, { id: SUB }, { uid: "uid_member", method: "POST", raw: form(svg, "image/png") });
    expect(member.status).toBe(403);
    expect(scenario()).toBeUndefined();
  });
});

describe("POST with JSON { mediaId } — a photo from the Media Library", () => {
  const PATH = `media/${SUB}/m_png/logo.png`;
  const OTHER_PATH = `media/${OTHER_SUB}/m_other/logo.png`;

  function seedMedia(sub: string, mediaId: string, storagePath: string, bytes: Uint8Array, size = bytes.byteLength) {
    state.docs.set(`subAccounts/${sub}/media/${mediaId}`, {
      agencyId: "ag_1", subAccountId: sub, createdByUid: "uid_admin", name: "logo.png",
      folderId: null, storagePath, contentType: "image/png", size, kind: "image", downloadUrl: "https://x",
    });
    bucket.objects.set(storagePath, bytes);
  }

  it("downloads the object and hands the provider the sniffed bytes", async () => {
    seedMedia(SUB, "m_png", PATH, PNG);
    const { status, body } = await json(call(POST, { id: SUB }, { method: "POST", body: { mediaId: "m_png" } }));
    expect(status).toBe(200);
    expect(String(body.profilePictureUrl)).toMatch(/^data:image\/png;base64,/);
    expect(bucket.downloads).toEqual([PATH]);
    expect(scenario()?.calls).toEqual([{ op: "uploadProfilePhoto", arg: `image/png:${PNG.byteLength}` }]);
  });

  it("refuses a mediaId that belongs to another sub-account", async () => {
    seedMedia(OTHER_SUB, "m_other", OTHER_PATH, PNG);
    const { status } = await json(call(POST, { id: SUB }, { method: "POST", body: { mediaId: "m_other" } }));
    expect(status).toBe(404);
    expect(bucket.downloads).toEqual([]);
    expect(scenario()).toBeUndefined();
  });

  it("refuses a doc under this sub-account whose object path points at another tenant", async () => {
    seedMedia(SUB, "m_forged", OTHER_PATH, PNG);
    const { status } = await json(call(POST, { id: SUB }, { method: "POST", body: { mediaId: "m_forged" } }));
    expect(status).toBe(404);
    expect(bucket.downloads).toEqual([]);
  });

  it("applies the same byte gate: a library GIF is refused, a >5 MB doc is refused before download", async () => {
    seedMedia(SUB, "m_gif", `media/${SUB}/m_gif/a.gif`, new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
    const gif = await json(call(POST, { id: SUB }, { method: "POST", body: { mediaId: "m_gif" } }));
    expect(gif.status).toBe(400);
    expect(gif.body.error).toMatch(/JPEG or PNG/);

    seedMedia(SUB, "m_big", `media/${SUB}/m_big/big.png`, PNG, MAX_PHOTO_BYTES + 1);
    const big = await json(call(POST, { id: SUB }, { method: "POST", body: { mediaId: "m_big" } }));
    expect(big.status).toBe(400);
    expect(big.body.error).toMatch(/5 MB/);
    expect(bucket.downloads).toEqual([`media/${SUB}/m_gif/a.gif`]);
    expect(scenario()).toBeUndefined();
  });

  it("400s a missing mediaId and 403s a member", async () => {
    expect((await call(POST, { id: SUB }, { method: "POST", body: {} })).status).toBe(400);
    seedMedia(SUB, "m_png", PATH, PNG);
    expect((await call(POST, { id: SUB }, { uid: "uid_member", method: "POST", body: { mediaId: "m_png" } })).status).toBe(403);
    expect(bucket.downloads).toEqual([]);
  });
});
