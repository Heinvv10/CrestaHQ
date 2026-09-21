import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const m = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock("@/lib/auth/require-tenancy", () => ({ requireSubAccountAdmin: m.access }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "ts" } }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/media-fake")).mediaAdminMock());

import { mediaFake, resetMediaFake } from "@/test/media-fake";
import { POST } from "./route";

/** POST /media/folders — admin-only folder create. */

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
const folders = () => [...mediaFake.docs.keys()].filter((p) => p.includes("/mediaFolders/"));

it("creates a folder for an admin", async () => {
  const res = await POST(req("POST", { name: "Brand", parentId: null }), ctx);
  expect(res.status).toBe(200);
  expect(folders()).toHaveLength(1);
});

it("403s a non-admin and writes nothing", async () => {
  m.access.mockResolvedValue(forbidden());
  expect((await POST(req("POST", { name: "Brand" }), ctx)).status).toBe(403);
  expect(folders()).toHaveLength(0);
});

it("400s malformed JSON; maps MediaErrors (bad name 400, missing parent 404)", async () => {
  const bad = await POST(req("POST", undefined, "not json"), ctx);
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe("Invalid JSON body");
  expect((await POST(req("POST", { name: "" }), ctx)).status).toBe(400);
  expect((await POST(req("POST", { name: "A", parentId: "nope" }), ctx)).status).toBe(404);
  expect(folders()).toHaveLength(0);
});
