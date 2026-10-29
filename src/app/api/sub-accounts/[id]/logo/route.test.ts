import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

// Real require-tenancy: only the Admin SDK underneath is faked, so the
// member/admin/agency-owner checks under test are the production ones.
const m = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  claims: new Map<string, Record<string, unknown>>(),
  writes: [] as Array<{ op: string; path: string; value?: unknown }>,
  reads: [] as string[],
}));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "ts" } }));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({ uid, customClaims: m.claims.get(uid) ?? {} }),
  }),
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => {
        m.reads.push(path);
        return { exists: m.docs.has(path), data: () => m.docs.get(path) };
      },
      set: async (value: Record<string, unknown>, opts?: { merge?: boolean }) => {
        m.writes.push({ op: "set", path, value });
        m.docs.set(path, opts?.merge ? { ...(m.docs.get(path) ?? {}), ...value } : value);
      },
      update: async (value: Record<string, unknown>) => {
        m.writes.push({ op: "update", path, value });
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

let png: string;
beforeAll(async () => {
  const buf = await sharp({ create: { width: 40, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png()
    .toBuffer();
  png = buf.toString("base64");
});

const req = (uid: string | null, method: string, body?: string) =>
  new Request("http://127.0.0.1:4301/api/sub-accounts/sa1/logo", {
    method,
    headers: uid ? { "x-user-uid": uid, "content-type": "application/json" } : {},
    body,
  });
const ctx = (id = "sa1") => ({ params: Promise.resolve({ id }) });
const upload = (uid: string | null, payload: unknown, id = "sa1") =>
  POST(req(uid, "POST", typeof payload === "string" ? payload : JSON.stringify(payload)), ctx(id));

beforeEach(() => {
  m.docs.clear();
  m.claims.clear();
  m.writes.length = 0;
  m.reads.length = 0;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.com");
  m.docs.set("subAccounts/sa1", { agencyId: "ag1", name: "Acme" });
  m.docs.set("subAccounts/sa1/subAccountMembers/admin1", { role: "admin", status: "active" });
  m.docs.set("subAccounts/sa1/subAccountMembers/user1", { role: "user", status: "active" });
  m.docs.set("subAccounts/sa1/subAccountMembers/gone1", { role: "admin", status: "removed" });
  for (const uid of ["admin1", "user1", "gone1", "stranger"]) m.claims.set(uid, { status: "active" });
  m.claims.set("owner1", { status: "active", agencyRole: "owner", agencyId: "ag1" });
  m.claims.set("owner2", { status: "active", agencyRole: "owner", agencyId: "ag2" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/sub-accounts/[id]/logo — upload", () => {
  it("stores the logo server-side and points logoUrl at the public route", async () => {
    const res = await upload("admin1", { data: png, mime: "image/png" });
    expect(res.status).toBe(200);
    const { logoUrl } = (await res.json()) as { logoUrl: string };
    const stored = m.docs.get("subAccounts/sa1/private/brandLogo") as { data: string; mime: string; version: number };
    expect(stored.data).toBe(png);
    expect(stored.mime).toBe("image/png");
    // The app URL, never the request's bind-address origin.
    expect(logoUrl).toBe(`https://crm.example.com/api/brand/logo/sa/sa1?v=${stored.version}`);
    expect(m.docs.get("subAccounts/sa1")?.logoUrl).toBe(logoUrl);
  });

  it("lets the parent agency's owner upload", async () => {
    expect((await upload("owner1", { data: png, mime: "image/png" })).status).toBe(200);
  });

  it.each([
    ["a plain member", "user1", 403],
    ["an inactive admin", "gone1", 403],
    ["a non-member", "stranger", 403],
    ["another agency's owner (cross-tenant)", "owner2", 403],
    ["no session", null, 401],
  ])("refuses %s and writes nothing", async (_label, uid, status) => {
    expect((await upload(uid, { data: png, mime: "image/png" })).status).toBe(status);
    expect(m.writes).toEqual([]);
  });

  it.each(["..", "sa1/private/brandLogo", "__x__"])("404s a bad id %j before any read", async (id) => {
    const res = await upload("owner1", { data: png, mime: "image/png" }, id);
    expect(res.status).toBe(404);
    expect(m.reads).toEqual([]);
    expect(m.writes).toEqual([]);
  });

  it.each(["sa.1", "sa 1", "x".repeat(129)])(
    "400s a doc id the serve route would never answer for (%j), before any read",
    async (id) => {
      const res = await upload("owner1", { data: png, mime: "image/png" }, id);
      expect(res.status).toBe(400);
      expect(m.reads).toEqual([]);
      expect(m.writes).toEqual([]);
    },
  );

  it("refuses an SVG and an HTML body", async () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64");
    expect((await upload("admin1", { data: svg, mime: "image/svg+xml" })).status).toBe(400);
    expect((await upload("admin1", { data: svg, mime: "image/png" })).status).toBe(400);
    const html = Buffer.from("<html><script>1</script></html>").toString("base64");
    expect((await upload("admin1", { data: html, mime: "image/png" })).status).toBe(400);
    expect(m.writes).toEqual([]);
  });

  it("413s a body over the cap without storing", async () => {
    const res = await upload("admin1", { data: "A".repeat(700_000), mime: "image/png" });
    expect(res.status).toBe(413);
    expect(m.writes).toEqual([]);
  });

  it("400s a body that isn't JSON", async () => {
    expect((await upload("admin1", "{not json")).status).toBe(400);
    expect(m.writes).toEqual([]);
  });

  it("503s without NEXT_PUBLIC_APP_URL and stores nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const res = await upload("admin1", { data: png, mime: "image/png" });
    expect(res.status).toBe(503);
    expect(m.writes).toEqual([]);
  });
});

describe("DELETE /api/sub-accounts/[id]/logo — remove", () => {
  it("deletes the stored logo and clears an uploaded logoUrl", async () => {
    m.docs.set("subAccounts/sa1/private/brandLogo", { data: png, mime: "image/png", version: 1 });
    m.docs.set("subAccounts/sa1", { agencyId: "ag1", logoUrl: "https://crm.example.com/api/brand/logo/sa/sa1?v=1" });
    const res = await DELETE(req("admin1", "DELETE"), ctx());
    expect(res.status).toBe(200);
    expect(m.docs.has("subAccounts/sa1/private/brandLogo")).toBe(false);
    expect(m.docs.get("subAccounts/sa1")?.logoUrl).toBeNull();
  });

  it("clears logoUrl before deleting the blob, so a failure between never leaves a dead logoUrl", async () => {
    m.docs.set("subAccounts/sa1/private/brandLogo", { data: png, mime: "image/png", version: 1 });
    m.docs.set("subAccounts/sa1", { agencyId: "ag1", logoUrl: "https://crm.example.com/api/brand/logo/sa/sa1?v=1" });
    await DELETE(req("admin1", "DELETE"), ctx());
    expect(m.writes.map(({ op, path }) => `${op} ${path}`)).toEqual([
      "update subAccounts/sa1",
      "delete subAccounts/sa1/private/brandLogo",
    ]);
  });

  it("clears its own upload minted under an earlier NEXT_PUBLIC_APP_URL", async () => {
    m.docs.set("subAccounts/sa1/private/brandLogo", { data: png, mime: "image/png", version: 1 });
    m.docs.set("subAccounts/sa1", { agencyId: "ag1", logoUrl: "https://old-host.example.org/api/brand/logo/sa/sa1?v=1" });
    await DELETE(req("admin1", "DELETE"), ctx());
    expect(m.docs.get("subAccounts/sa1")?.logoUrl).toBeNull();
    expect(m.docs.has("subAccounts/sa1/private/brandLogo")).toBe(false);
  });

  it.each([
    ["a pasted logo URL", "https://cdn.example.com/logo.png"],
    ["another tenant's uploaded logo", "https://crm.example.com/api/brand/logo/sa/sa2?v=1"],
    ["a URL carrying the prefix in its query", "https://cdn.example.com/logo.png?r=/api/brand/logo/"],
  ])("leaves %s alone", async (_label, url) => {
    m.docs.set("subAccounts/sa1", { agencyId: "ag1", logoUrl: url });
    await DELETE(req("admin1", "DELETE"), ctx());
    expect(m.docs.get("subAccounts/sa1")?.logoUrl).toBe(url);
  });

  it.each([
    ["a plain member", "user1", 403],
    ["another agency's owner (cross-tenant)", "owner2", 403],
  ])("refuses %s and deletes nothing", async (_label, uid, status) => {
    m.docs.set("subAccounts/sa1/private/brandLogo", { data: png, mime: "image/png", version: 1 });
    expect((await DELETE(req(uid, "DELETE"), ctx())).status).toBe(status);
    expect(m.writes).toEqual([]);
  });

  it("404s a bad id before any read", async () => {
    expect((await DELETE(req("owner1", "DELETE"), ctx(".."))).status).toBe(404);
    expect(m.reads).toEqual([]);
    expect(m.writes).toEqual([]);
  });
});

describe("this instance's logo cache (breaker R3)", () => {
  const prime = (id: string) =>
    cacheLogo("sa", id, { body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mime: "image/png", version: 1 }, 0);

  it("an upload drops this sub-account's cached logo, and only its own", async () => {
    prime("sa1");
    prime("sa2");
    expect((await upload("admin1", { data: png, mime: "image/png" })).status).toBe(200);
    expect(getCachedLogo("sa", "sa1")).toBeNull();
    expect(getCachedLogo("sa", "sa2")).not.toBeNull();
  });

  it("a remove drops this sub-account's cached logo", async () => {
    prime("sa1");
    m.docs.set("subAccounts/sa1", { agencyId: "ag1", logoUrl: "https://crm.example.com/api/brand/logo/sa/sa1?v=1" });
    expect((await DELETE(req("admin1", "DELETE"), ctx())).status).toBe(200);
    expect(getCachedLogo("sa", "sa1")).toBeNull();
  });

  it("a refused caller drops nothing", async () => {
    prime("sa1");
    expect((await DELETE(req("user1", "DELETE"), ctx())).status).toBe(403);
    expect(getCachedLogo("sa", "sa1")).not.toBeNull();
  });
});
