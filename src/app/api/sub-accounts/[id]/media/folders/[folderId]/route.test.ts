import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const m = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock("@/lib/auth/require-tenancy", () => ({ requireSubAccountAdmin: m.access }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "ts" } }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/media-fake")).mediaAdminMock());

import { mediaFake, resetMediaFake } from "@/test/media-fake";
import { DELETE, PATCH } from "./route";

/** PATCH/DELETE /media/folders/[folderId] — admin-only rename + delete. */

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

const ctx = (folderId: string) => ({ params: Promise.resolve({ id: SA, folderId }) });
const DOC = `subAccounts/${SA}/mediaFolders/f1`;

beforeEach(() => {
  mediaFake.docs.set(DOC, { name: "F", parentId: null });
});

it("renames and deletes an empty folder for an admin", async () => {
  expect((await PATCH(req("PATCH", { name: "G" }), ctx("f1"))).status).toBe(200);
  expect(mediaFake.docs.get(DOC)?.name).toBe("G");
  expect((await DELETE(req("DELETE"), ctx("f1"))).status).toBe(200);
  expect(mediaFake.docs.has(DOC)).toBe(false);
});

it("403s a non-admin on both verbs and changes nothing", async () => {
  m.access.mockResolvedValue(forbidden());
  expect((await PATCH(req("PATCH", { name: "G" }), ctx("f1"))).status).toBe(403);
  expect((await DELETE(req("DELETE"), ctx("f1"))).status).toBe(403);
  expect(mediaFake.docs.get(DOC)?.name).toBe("F");
});

it("400s malformed JSON on PATCH", async () => {
  const bad = await PATCH(req("PATCH", undefined, "{"), ctx("f1"));
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe("Invalid JSON body");
});

it("maps MediaErrors: non-empty 409, malformed id 404, missing 404", async () => {
  mediaFake.docs.set(`subAccounts/${SA}/media/x`, { folderId: "f1" });
  expect((await DELETE(req("DELETE"), ctx("f1"))).status).toBe(409);
  expect((await DELETE(req("DELETE"), ctx("f/1"))).status).toBe(404);
  expect((await PATCH(req("PATCH", { name: "G" }), ctx("nope"))).status).toBe(404);
  expect(mediaFake.docs.has(DOC)).toBe(true);
});
