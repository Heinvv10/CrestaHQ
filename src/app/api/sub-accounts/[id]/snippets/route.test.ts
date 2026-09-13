import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  docGet: vi.fn(),
  set: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  listGet: vi.fn(),
  where: vi.fn(),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: m.access,
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "ts" },
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      path,
      get: () => m.docGet(path),
      update: (d: unknown) => m.update(path, d),
      delete: () => m.del(path),
    }),
    collection: (path: string) => ({
      doc: () => ({ id: "new1", set: (d: unknown) => m.set(path, d) }),
      where: (...args: unknown[]) => {
        m.where(path, ...args);
        return { get: m.listGet };
      },
    }),
  }),
}));
import { GET, POST } from "./route";
import { DELETE, PATCH } from "./[snippetId]/route";

const ctx = { params: Promise.resolve({ id: "saA" }) };
const one = { params: Promise.resolve({ id: "saA", snippetId: "s1" }) };
const req = (method: string, body?: unknown) =>
  new Request("https://example.com", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const valid = {
  type: "text",
  name: "Hi",
  body: "Hello {{contact.first_name}}",
};
const ts = (n: number) => ({ toMillis: () => n });

beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ uid: "member1" });
  m.docGet.mockImplementation(async (path: string) =>
    path === "subAccounts/saA"
      ? { exists: true, data: () => ({ agencyId: "agA" }) }
      : { exists: true, data: () => ({ subAccountId: "saA", name: "Hi" }) }
  );
});

it("the member guard runs before any read or write", async () => {
  m.access.mockResolvedValue(
    NextResponse.json({ error: "Not a member" }, { status: 403 })
  );
  expect((await GET(req("GET"), ctx)).status).toBe(403);
  expect((await POST(req("POST", valid), ctx)).status).toBe(403);
  expect((await PATCH(req("PATCH", valid), one)).status).toBe(403);
  expect((await DELETE(req("DELETE"), one)).status).toBe(403);
  expect(m.docGet).not.toHaveBeenCalled();
  expect(m.listGet).not.toHaveBeenCalled();
  expect(m.access).toHaveBeenCalledWith(expect.any(Request), "saA");
});

it("GET lists only the route's sub-account, newest-updated first", async () => {
  m.listGet.mockResolvedValue({
    docs: [
      {
        id: "old",
        data: () => ({
          name: "Old",
          body: "b",
          type: "text",
          updatedAt: ts(1),
        }),
      },
      {
        id: "new",
        data: () => ({
          name: "New",
          body: "b",
          type: "email",
          subject: "S",
          folder: "Sales",
          updatedAt: ts(5),
        }),
      },
    ],
  });
  const res = await GET(req("GET"), ctx);
  expect(m.where).toHaveBeenCalledWith("snippets", "subAccountId", "==", "saA");
  const { snippets } = await res.json();
  expect(snippets.map((s: { id: string }) => s.id)).toEqual(["new", "old"]);
  expect(snippets[0]).toMatchObject({
    type: "email",
    subject: "S",
    folder: "Sales",
    updatedAt: 5,
  });
  expect(snippets[1]).toMatchObject({ subject: null, folder: null });
});

it("POST stamps tenant keys from the route and caller, never the body", async () => {
  const res = await POST(
    req("POST", {
      ...valid,
      agencyId: "evil",
      subAccountId: "saB",
      createdByUid: "x",
    }),
    ctx
  );
  expect(res.status).toBe(200);
  expect(m.set).toHaveBeenCalledWith("snippets", {
    type: "text",
    name: "Hi",
    body: "Hello {{contact.first_name}}",
    subject: null,
    folder: null,
    agencyId: "agA",
    subAccountId: "saA",
    createdByUid: "member1",
    createdAt: "ts",
    updatedAt: "ts",
  });
});

it("POST refuses an invalid snippet without writing", async () => {
  const res = await POST(req("POST", { ...valid, type: "email" }), ctx);
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("Email snippets need a subject.");
  expect(m.set).not.toHaveBeenCalled();
});

it("PATCH and DELETE refuse another sub-account's snippet as not found", async () => {
  m.docGet.mockResolvedValue({
    exists: true,
    data: () => ({ subAccountId: "saB" }),
  });
  expect((await PATCH(req("PATCH", valid), one)).status).toBe(404);
  expect((await DELETE(req("DELETE"), one)).status).toBe(404);
  expect(m.update).not.toHaveBeenCalled();
  expect(m.del).not.toHaveBeenCalled();
});

it("PATCH writes only the validated fields; DELETE removes the doc", async () => {
  const res = await PATCH(
    req("PATCH", {
      ...valid,
      subAccountId: "saB",
      createdByUid: "x",
      folder: "Sales",
    }),
    one
  );
  expect(res.status).toBe(200);
  expect(m.update).toHaveBeenCalledWith("snippets/s1", {
    type: "text",
    name: "Hi",
    body: "Hello {{contact.first_name}}",
    subject: null,
    folder: "Sales",
    updatedAt: "ts",
  });
  expect((await DELETE(req("DELETE"), one)).status).toBe(200);
  expect(m.del).toHaveBeenCalledWith("snippets/s1");
});
