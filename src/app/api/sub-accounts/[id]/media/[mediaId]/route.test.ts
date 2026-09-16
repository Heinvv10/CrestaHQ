import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const m = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock("@/lib/auth/require-tenancy", () => ({ requireSubAccountAdmin: m.access }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "ts" } }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/media-fake")).mediaAdminMock());

import { mediaFake, resetMediaFake } from "@/test/media-fake";
import { DELETE, PATCH } from "./route";

/** PATCH/DELETE /media/[mediaId] — admin-only rename, move, delete. */

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

const ctx = (mediaId: string) => ({ params: Promise.resolve({ id: SA, mediaId }) });
const DOC = `subAccounts/${SA}/media/m1`;
const PATH = `media/${SA}/m1/logo.png`;

beforeEach(() => {
  mediaFake.docs.set(DOC, { name: "Logo", folderId: null, storagePath: PATH });
  mediaFake.objects.set(PATH, { size: "1", contentType: "image/png" });
});

it("renames and deletes for an admin", async () => {
  expect((await PATCH(req("PATCH", { name: "New" }), ctx("m1"))).status).toBe(200);
  expect(mediaFake.docs.get(DOC)?.name).toBe("New");
  expect((await DELETE(req("DELETE"), ctx("m1"))).status).toBe(200);
  expect(mediaFake.docs.has(DOC)).toBe(false);
  expect(mediaFake.objects.has(PATH)).toBe(false);
});

it("403s a non-admin on both verbs and changes nothing", async () => {
  m.access.mockResolvedValue(forbidden());
  expect((await PATCH(req("PATCH", { name: "New" }), ctx("m1"))).status).toBe(403);
  expect((await DELETE(req("DELETE"), ctx("m1"))).status).toBe(403);
  expect(mediaFake.docs.get(DOC)?.name).toBe("Logo");
  expect(mediaFake.objects.has(PATH)).toBe(true);
});

it("400s malformed JSON on PATCH", async () => {
  const bad = await PATCH(req("PATCH", undefined, "{"), ctx("m1"));
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe("Invalid JSON body");
});

it("maps MediaErrors: malformed id 404, missing folder 404, bad name 400", async () => {
  expect((await PATCH(req("PATCH", { name: "X" }), ctx("m 1"))).status).toBe(404);
  expect((await DELETE(req("DELETE"), ctx("../m1"))).status).toBe(404);
  expect((await PATCH(req("PATCH", { folderId: "nope" }), ctx("m1"))).status).toBe(404);
  expect((await PATCH(req("PATCH", { name: "" }), ctx("m1"))).status).toBe(400);
  expect(mediaFake.docs.get(DOC)).toMatchObject({ name: "Logo", folderId: null });
});
