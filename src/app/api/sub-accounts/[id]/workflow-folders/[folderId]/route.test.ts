import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Workflow folders, driven through the real routes over an in-memory
 * Firestore that honours `where`; only tenancy auth is stubbed.
 *
 * sa1 and sa2 each own a folder called "f1" — same id, different
 * sub-accounts — so a query or path that forgets the sub-account scope moves
 * or deletes the other tenant's docs and these tests go red.
 */

const mem = createMemoryFirestore();
const m = vi.hoisted(() => ({ access: vi.fn() }));

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: m.access,
}));

const { DELETE, PATCH } = await import("./route");
const { GET, POST } = await import("../route");

const req = (method: string, body?: unknown) =>
  new Request("https://app.test/api", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string, folderId = "f1") => ({
  params: Promise.resolve({ id, folderId }),
});

const wf = (subAccountId: string, folderId?: string | null) => ({
  subAccountId, agencyId: "ag1", createdByUid: "u1", name: "W", status: "draft",
  startNodeId: null, nodes: {}, trigger: { type: "contact.created", filters: { all: [] } },
  ...(folderId === undefined ? {} : { folderId }),
});
const folder = (subAccountId: string, name: string, order: number) => ({
  name, order, agencyId: "ag1", subAccountId, createdByUid: "u1",
});

beforeEach(() => {
  mem.clear();
  m.access.mockReset();
  m.access.mockResolvedValue({ uid: "u1" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "One" });
  mem.seed("subAccounts/sa1/workflowFolders/f1", folder("sa1", "Sales", 0));
  mem.seed("subAccounts/sa1/workflowFolders/f2", folder("sa1", "Ops", 1));
  mem.seed("subAccounts/sa2/workflowFolders/f1", folder("sa2", "Theirs", 0));
  mem.seed("workflows/a", wf("sa1", "f1"));
  mem.seed("workflows/b", wf("sa1", "f1"));
  mem.seed("workflows/c", wf("sa1", "f2"));
  mem.seed("workflows/d", wf("sa1"));
  mem.seed("workflows/other", wf("sa2", "f1"));
});

describe("DELETE a folder", () => {
  it("unfiles exactly its own workflows and keeps every workflow", async () => {
    const res = await DELETE(req("DELETE"), ctx("sa1"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "f1", movedWorkflows: 2 });
    expect(mem.read("subAccounts/sa1/workflowFolders/f1")).toBeUndefined();
    expect(mem.read("workflows/a")?.folderId).toBeNull();
    expect(mem.read("workflows/b")?.folderId).toBeNull();
    expect(mem.read("workflows/c")?.folderId).toBe("f2");
    expect(mem.list("workflows")).toHaveLength(5);
    // The other sub-account's same-id folder and its workflow are untouched.
    expect(mem.read("subAccounts/sa2/workflowFolders/f1")?.name).toBe("Theirs");
    expect(mem.read("workflows/other")?.folderId).toBe("f1");
  });

  it("404s on a folder that is not under this sub-account", async () => {
    mem.seed("subAccounts/sa2/workflowFolders/only2", folder("sa2", "X", 1));
    const res = await DELETE(req("DELETE"), ctx("sa1", "only2"));

    expect(res.status).toBe(404);
    expect(mem.read("subAccounts/sa2/workflowFolders/only2")).toBeDefined();
  });
});

describe("PATCH a folder", () => {
  it("renames", async () => {
    const res = await PATCH(req("PATCH", { name: "  Leads " }), ctx("sa1"));
    expect(res.status).toBe(200);
    expect(mem.read("subAccounts/sa1/workflowFolders/f1")?.name).toBe("Leads");
  });

  it("refuses an empty name and a path-shaped id", async () => {
    expect((await PATCH(req("PATCH", { name: " " }), ctx("sa1"))).status).toBe(400);
    const res = await PATCH(req("PATCH", { name: "x" }), ctx("sa1", "f1/../../../sa2/workflowFolders/f1"));
    expect(res.status).toBe(404);
    expect(mem.read("subAccounts/sa2/workflowFolders/f1")?.name).toBe("Theirs");
  });
});

describe("GET / POST", () => {
  it("lists only this sub-account's folders, by order", async () => {
    const res = await GET(req("GET"), { params: Promise.resolve({ id: "sa1" }) });
    const { folders } = (await res.json()) as { folders: { id: string; name: string }[] };
    expect(folders.map((f) => f.name)).toEqual(["Sales", "Ops"]);
  });

  it("creates a folder last, stamped with the sub-account's tenancy", async () => {
    const res = await POST(req("POST", { name: "Nurture" }), { params: Promise.resolve({ id: "sa1" }) });
    const { id } = (await res.json()) as { id: string };

    expect(res.status).toBe(200);
    expect(mem.read(`subAccounts/sa1/workflowFolders/${id}`)).toMatchObject({
      name: "Nurture", order: 2, agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1",
    });
  });
});

it("the member guard runs before any read or write", async () => {
  m.access.mockResolvedValue(NextResponse.json({ error: "Not a member" }, { status: 403 }));

  expect((await DELETE(req("DELETE"), ctx("sa1"))).status).toBe(403);
  expect((await PATCH(req("PATCH", { name: "x" }), ctx("sa1"))).status).toBe(403);
  expect((await POST(req("POST", { name: "x" }), { params: Promise.resolve({ id: "sa1" }) })).status).toBe(403);
  expect((await GET(req("GET"), { params: Promise.resolve({ id: "sa1" }) })).status).toBe(403);
  expect(mem.read("subAccounts/sa1/workflowFolders/f1")?.name).toBe("Sales");
  expect(mem.list("subAccounts/sa1/workflowFolders")).toHaveLength(2);
});
