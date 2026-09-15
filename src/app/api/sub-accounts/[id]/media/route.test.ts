import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const m = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock("@/lib/auth/require-tenancy", () => ({ requireSubAccountAdmin: m.access }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "ts" } }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/media-fake")).mediaAdminMock());

import { downloadUrl, mediaFake, resetMediaFake } from "@/test/media-fake";
import { POST } from "./route";

/** POST /media — admin-only register of an uploaded object. */

const SA = "sa_1";
const req = (method: string, body?: unknown, raw?: string) =>
  new Request("https://example.com", {
    method,
    headers: { "content-type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
const forbidden = () => NextResponse.json({ error: "Sub-account admin only" }, { status: 403 });

beforeEach(() => {
  vi.resetAllMocks();
  resetMediaFake();
  mediaFake.docs.set(`subAccounts/${SA}`, { agencyId: "ag_1" });
  m.access.mockResolvedValue({ uid: "uid_admin", subAccountId: SA, subAccountRole: "admin" });
});

const ctx = { params: Promise.resolve({ id: SA }) };
const PATH = `media/${SA}/m1/logo.png`;
const good = { mediaId: "m1", name: "Logo", storagePath: PATH, downloadUrl: downloadUrl(PATH), folderId: null };

it("registers an upload for an admin, with the bucket's metadata", async () => {
  mediaFake.objects.set(PATH, { size: "42", contentType: "image/png" });
  const res = await POST(req("POST", good), ctx);
  expect(res.status).toBe(200);
  expect(m.access).toHaveBeenCalledWith(expect.any(Request), SA);
  expect(mediaFake.docs.get(`subAccounts/${SA}/media/m1`)).toMatchObject({ size: 42, createdByUid: "uid_admin", agencyId: "ag_1" });
});

it("403s a non-admin before reading the body or touching Firestore", async () => {
  m.access.mockResolvedValue(forbidden());
  mediaFake.objects.set(PATH, { size: "42", contentType: "image/png" });
  const res = await POST(req("POST", good), ctx);
  expect(res.status).toBe(403);
  expect(mediaFake.docs.has(`subAccounts/${SA}/media/m1`)).toBe(false);
});

it("400s malformed JSON", async () => {
  const bad = await POST(req("POST", undefined, "{nope"), ctx);
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe("Invalid JSON body");
});

it("maps a MediaError to its status (forged path → 400, missing object → 404)", async () => {
  const forged = await POST(req("POST", { ...good, storagePath: "media/sa_2/m1/logo.png" }), ctx);
  expect(forged.status).toBe(400);
  expect(((await forged.json()) as { error: string }).error).toMatch(/prefix/);
  expect((await POST(req("POST", good), ctx)).status).toBe(404);
});
