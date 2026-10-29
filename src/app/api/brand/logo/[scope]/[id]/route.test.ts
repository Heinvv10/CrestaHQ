import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  reads: [] as string[],
  fail: false,
}));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "ts" } }));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => {
        m.reads.push(path);
        if (m.fail) throw new Error("backend unavailable");
        const data = m.docs.get(path);
        return { exists: !!data, data: () => data };
      },
    }),
  }),
}));

import { GET } from "./route";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const get = (scope: string, id: string, query = "") =>
  GET(new Request(`https://crm.example.com/api/brand/logo/${scope}/${id}${query}`), {
    params: Promise.resolve({ scope, id }),
  });

beforeEach(() => {
  m.docs.clear();
  m.reads.length = 0;
  m.fail = false;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

it("serves a sub-account logo from subAccounts/{id}/private/brandLogo", async () => {
  m.docs.set("subAccounts/sa1/private/brandLogo", { data: PNG_BYTES.toString("base64"), mime: "image/png", version: 7 });
  const res = await get("sa", "sa1", "?v=7");
  expect(res.status).toBe(200);
  expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-disposition")).toBe("inline");
  expect(res.headers.get("cache-control")).toContain("immutable");
});

it("serves an agency logo from agencies/{id}/brandAssets/logo", async () => {
  m.docs.set("agencies/ag1/brandAssets/logo", { data: PNG_BYTES.toString("base64"), mime: "image/png", version: 1 });
  const res = await get("agency", "ag1", "?v=1");
  expect(res.status).toBe(200);
  expect(m.reads).toEqual(["agencies/ag1/brandAssets/logo"]);
});

it("takes Content-Type from the stored mime only, never the bytes or the URL", async () => {
  // PNG bytes stored with a webp mime: the stored value wins, not a sniff.
  m.docs.set("subAccounts/sa1/private/brandLogo", { data: PNG_BYTES.toString("base64"), mime: "image/webp", version: 7 });
  const res = await get("sa", "sa1", "?v=7&type=text/html");
  expect(res.headers.get("content-type")).toBe("image/webp");
});

it("404s a stored mime outside PNG/WebP", async () => {
  m.docs.set("subAccounts/sa1/private/brandLogo", { data: "PHN2Zy8+", mime: "image/svg+xml", version: 7 });
  expect((await get("sa", "sa1", "?v=7")).status).toBe(404);
  m.docs.set("subAccounts/sa1/private/brandLogo", { data: "PHN2Zy8+", mime: "text/html", version: 7 });
  expect((await get("sa", "sa1", "?v=7")).status).toBe(404);
});

it("caches as immutable only for the stored version", async () => {
  m.docs.set("subAccounts/sa1/private/brandLogo", { data: PNG_BYTES.toString("base64"), mime: "image/png", version: 7 });
  for (const q of ["", "?v=6", "?v=", "?v=7x"]) {
    const res = await get("sa", "sa1", q);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  }
});

it("404s a missing logo", async () => {
  expect((await get("sa", "nope")).status).toBe(404);
});

it("404s an unknown scope without reading", async () => {
  expect((await get("users", "u1")).status).toBe(404);
  expect((await get("agencies", "ag1")).status).toBe(404);
  expect(m.reads).toEqual([]);
});

it.each(["..", ".", "__x__", "a/b", "a%2Fb", "a.b", "x".repeat(129), ""])(
  "404s a bad id %j without reading",
  async (id) => {
    expect((await get("sa", id)).status).toBe(404);
    expect(m.reads).toEqual([]);
  },
);

it("404s (never 500s) when the read throws", async () => {
  m.fail = true;
  expect((await get("sa", "sa1")).status).toBe(404);
  expect(console.warn).toHaveBeenCalledWith("[brand/logo] read failed:", "backend unavailable");
});
