import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());

import { ORIGINAL_ENV, SUB, call, json, resetWaSettings, scenario } from "@/test/wa-settings-harness";
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

beforeEach(() => resetWaSettings());
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
