import { afterEach, beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";

// The serve route and the real sub-account upload route over one in-memory
// Firestore, in one module registry, so they share the instance's logo cache
// exactly as they do in a running server.
const m = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  reads: [] as string[],
}));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "ts" } }));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({ uid, customClaims: { status: "active" } }),
  }),
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => {
        m.reads.push(path);
        return { exists: m.docs.has(path), data: () => m.docs.get(path) };
      },
      set: async (value: Record<string, unknown>, opts?: { merge?: boolean }) => {
        m.docs.set(path, opts?.merge ? { ...(m.docs.get(path) ?? {}), ...value } : value);
      },
      update: async (value: Record<string, unknown>) => {
        m.docs.set(path, { ...(m.docs.get(path) ?? {}), ...value });
      },
      delete: async () => {
        m.docs.delete(path);
      },
    }),
  }),
}));

import { GET } from "./route";
import { POST } from "@/app/api/sub-accounts/[id]/logo/route";

const BLOB = "subAccounts/sa1/private/brandLogo";
const serve = (query = "") =>
  GET(new Request(`https://crm.example.com/api/brand/logo/sa/sa1${query}`), {
    params: Promise.resolve({ scope: "sa", id: "sa1" }),
  });

beforeEach(() => {
  m.docs.clear();
  m.reads.length = 0;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.com");
  m.docs.set("subAccounts/sa1", { agencyId: "ag1", name: "Acme" });
  m.docs.set("subAccounts/sa1/subAccountMembers/admin1", { role: "admin", status: "active" });
});
afterEach(() => vi.unstubAllEnvs());

it("a miss, then an upload on this instance, then a GET serves the new logo at once", async () => {
  // The miss is remembered: the repeat 404s without another read of the blob.
  expect((await serve()).status).toBe(404);
  expect((await serve()).status).toBe(404);
  expect(m.reads.filter((p) => p === BLOB)).toHaveLength(1);

  const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#036" } }).png().toBuffer();
  const res = await POST(
    new Request("http://127.0.0.1:4301/api/sub-accounts/sa1/logo", {
      method: "POST",
      headers: { "x-user-uid": "admin1", "content-type": "application/json" },
      body: JSON.stringify({ data: png.toString("base64"), mime: "image/png" }),
    }),
    { params: Promise.resolve({ id: "sa1" }) },
  );
  expect(res.status).toBe(200);
  const { logoUrl } = (await res.json()) as { logoUrl: string };

  // Well inside the 10 s negative TTL, both the new versioned URL and a bare one are served.
  for (const query of [new URL(logoUrl).search, ""]) {
    const got = await serve(query);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer()).equals(png)).toBe(true);
  }
  expect(m.reads.filter((p) => p === BLOB)).toHaveLength(2);
});
