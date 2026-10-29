import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";

// Real require-tenancy over a faked Admin SDK, so the owner check is the
// production one.
const m = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  claims: new Map<string, Record<string, unknown>>(),
  writes: [] as Array<{ op: string; path: string }>,
}));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "ts" } }));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({ uid, customClaims: m.claims.get(uid) ?? {} }),
  }),
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => ({ exists: m.docs.has(path), data: () => m.docs.get(path) }),
      set: async (value: Record<string, unknown>) => {
        m.writes.push({ op: "set", path });
        m.docs.set(path, value);
      },
      update: async (value: Record<string, unknown>) => {
        m.writes.push({ op: "update", path });
        m.docs.set(path, { ...(m.docs.get(path) ?? {}), ...value });
      },
      delete: async () => {
        m.writes.push({ op: "delete", path });
        m.docs.delete(path);
      },
    }),
  }),
}));

import { DELETE, POST } from "./route";
import { cacheLogo, getCachedLogo } from "@/lib/brand/logo-cache";

let webp: string;
beforeAll(async () => {
  webp = (await sharp({ create: { width: 30, height: 30, channels: 3, background: { r: 9, g: 9, b: 9 } } }).webp().toBuffer()).toString("base64");
});

const req = (uid: string | null, method: string, body?: unknown) =>
  new Request("http://127.0.0.1:4301/api/agency/logo", {
    method,
    headers: uid ? { "x-user-uid": uid } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  m.docs.clear();
  m.claims.clear();
  m.writes.length = 0;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.com");
  m.docs.set("agencies/ag1", { name: "Agency One" });
  m.claims.set("owner1", { status: "active", agencyRole: "owner", agencyId: "ag1" });
  m.claims.set("staff1", { status: "active", agencyRole: "staff", agencyId: "ag1" });
  m.claims.set("paused", { status: "suspended", agencyRole: "owner", agencyId: "ag1" });
  m.claims.set("member", { status: "active" });
});
afterEach(() => vi.unstubAllEnvs());

it("stores the owner's logo under their own agency and points logoUrl at it", async () => {
  const res = await POST(req("owner1", "POST", { data: webp, mime: "image/webp" }));
  expect(res.status).toBe(200);
  const stored = m.docs.get("agencies/ag1/brandAssets/logo") as { mime: string; version: number };
  expect(stored.mime).toBe("image/webp");
  expect(m.docs.get("agencies/ag1")?.logoUrl).toBe(
    `https://crm.example.com/api/brand/logo/agency/ag1?v=${stored.version}`,
  );
});

it.each([
  ["agency staff", "staff1", 403],
  ["an inactive owner", "paused", 403],
  ["a sub-account member", "member", 403],
  ["no session", null, 401],
])("refuses %s and writes nothing", async (_label, uid, status) => {
  expect((await POST(req(uid, "POST", { data: webp, mime: "image/webp" }))).status).toBe(status);
  expect((await DELETE(req(uid, "DELETE"))).status).toBe(status);
  expect(m.writes).toEqual([]);
});

it("400s an agency id the serve route would never answer for", async () => {
  m.claims.set("dotted", { status: "active", agencyRole: "owner", agencyId: "ag.1" });
  m.docs.set("agencies/ag.1", { name: "Dotted" });
  expect((await POST(req("dotted", "POST", { data: webp, mime: "image/webp" }))).status).toBe(400);
  expect(m.writes).toEqual([]);
});

it("refuses an SVG", async () => {
  const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64");
  expect((await POST(req("owner1", "POST", { data: svg, mime: "image/svg+xml" }))).status).toBe(400);
  expect(m.writes).toEqual([]);
});

it("413s a body over the cap", async () => {
  expect((await POST(req("owner1", "POST", { data: "A".repeat(700_000), mime: "image/webp" }))).status).toBe(413);
  expect(m.writes).toEqual([]);
});

it("DELETE clears an uploaded logoUrl but leaves a pasted one", async () => {
  m.docs.set("agencies/ag1/brandAssets/logo", { data: webp, mime: "image/webp", version: 1 });
  m.docs.set("agencies/ag1", { logoUrl: "https://crm.example.com/api/brand/logo/agency/ag1?v=1" });
  expect((await DELETE(req("owner1", "DELETE"))).status).toBe(200);
  expect(m.docs.has("agencies/ag1/brandAssets/logo")).toBe(false);
  expect(m.docs.get("agencies/ag1")?.logoUrl).toBeNull();

  m.docs.set("agencies/ag1", { logoUrl: "https://cdn.example.com/logo.svg" });
  await DELETE(req("owner1", "DELETE"));
  expect(m.docs.get("agencies/ag1")?.logoUrl).toBe("https://cdn.example.com/logo.svg");
});

it("DELETE clears logoUrl before deleting the blob", async () => {
  m.docs.set("agencies/ag1/brandAssets/logo", { data: webp, mime: "image/webp", version: 1 });
  m.docs.set("agencies/ag1", { logoUrl: "https://crm.example.com/api/brand/logo/agency/ag1?v=1" });
  await DELETE(req("owner1", "DELETE"));
  expect(m.writes.map(({ op, path }) => `${op} ${path}`)).toEqual([
    "update agencies/ag1",
    "delete agencies/ag1/brandAssets/logo",
  ]);
});

it("DELETE clears its own upload minted under an earlier NEXT_PUBLIC_APP_URL", async () => {
  m.docs.set("agencies/ag1", { logoUrl: "http://localhost:4301/api/brand/logo/agency/ag1?v=1" });
  await DELETE(req("owner1", "DELETE"));
  expect(m.docs.get("agencies/ag1")?.logoUrl).toBeNull();
});

it.each([
  ["another agency's uploaded logo", "https://crm.example.com/api/brand/logo/agency/ag2?v=1"],
  ["a URL carrying the prefix in its query", "https://cdn.example.com/logo.png?r=/api/brand/logo/"],
])("DELETE leaves %s alone", async (_label, url) => {
  m.docs.set("agencies/ag1", { logoUrl: url });
  await DELETE(req("owner1", "DELETE"));
  expect(m.docs.get("agencies/ag1")?.logoUrl).toBe(url);
});

it.each(["POST", "DELETE"])("%s drops this agency's cached logo on this instance, and only its own (breaker R3)", async (method) => {
  const prime = (id: string) =>
    cacheLogo("agency", id, { body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mime: "image/png", version: 1 });
  prime("ag1");
  prime("ag2");
  m.docs.set("agencies/ag1", { logoUrl: "https://crm.example.com/api/brand/logo/agency/ag1?v=1" });
  const res = method === "POST" ? await POST(req("owner1", "POST", { data: webp, mime: "image/webp" })) : await DELETE(req("owner1", "DELETE"));
  expect(res.status).toBe(200);
  expect(getCachedLogo("agency", "ag1")).toBeNull();
  expect(getCachedLogo("agency", "ag2")).not.toBeNull();
});
