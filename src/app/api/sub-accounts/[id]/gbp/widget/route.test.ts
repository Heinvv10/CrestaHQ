import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/sub-accounts/[id]/gbp/widget (GET/PUT/DELETE) and …/widget/rotate
 * (POST), driven through the REAL require-tenancy and gate on the in-memory
 * Firestore: who may configure the public reviews widget, what a config may
 * hold, and what rotate / revoke leave behind.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { AGENCY, OTHER_SA, SA, asUser, claims, mem, resetSync } from "@/test/gbp-sync-harness";
import { DELETE, GET, PUT } from "./route";
import { POST as ROTATE } from "./rotate/route";

const ORIGINAL = { ...process.env };
const BASE = `http://127.0.0.1:3100/api/sub-accounts`;
const params = (id = SA) => ({ params: Promise.resolve({ id }) });

type Json = Record<string, unknown>;
async function put(body: unknown, uid = "uid_admin", sa = SA) {
  const res = await PUT(asUser(`${BASE}/${sa}/gbp/widget`, uid, "PUT", JSON.stringify(body)), params(sa));
  return { status: res.status, body: (await res.json()) as Json };
}
async function get(uid = "uid_admin", sa = SA) {
  const res = await GET(asUser(`${BASE}/${sa}/gbp/widget`, uid), params(sa));
  return { status: res.status, body: (await res.json()) as Json };
}
async function del(uid = "uid_admin", sa = SA) {
  const res = await DELETE(asUser(`${BASE}/${sa}/gbp/widget`, uid, "DELETE"), params(sa));
  return { status: res.status, body: (await res.json()) as Json };
}
async function rotate(uid = "uid_admin", sa = SA) {
  const res = await ROTATE(asUser(`${BASE}/${sa}/gbp/widget/rotate`, uid, "POST"), params(sa));
  return { status: res.status, body: (await res.json()) as Json };
}

const VELO = "https://www.velocityfibre.co.za";
const CONFIG = { enabled: true, allowedOrigins: [VELO], maxReviews: 12 };
const widgetDocs = () => mem.list("gbpWidgets");
const meta = (sa = SA) => mem.read(`subAccounts/${sa}`)?.gbpWidgetMeta as Json | null | undefined;
const gateOff = (sa = SA) => mem.seed(`subAccounts/${sa}`, { ...mem.read(`subAccounts/${sa}`)!, googleEnabledByAgency: false });

beforeEach(() => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("PUT creates, then updates, ONE widget per sub-account", () => {
  it("creates an opaque publicId, the server-only doc and the member-readable meta", async () => {
    const { status, body } = await put(CONFIG);
    expect(status).toBe(200);
    const widget = body.widget as Json;
    expect(widget).toMatchObject({ enabled: true, allowedOrigins: [VELO], maxReviews: 12 });
    const id = widget.publicId as string;
    // 24 random bytes, base64url — nothing derived from a tenant id.
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(id).not.toContain(SA);
    expect(id).not.toContain(AGENCY);

    const docs = widgetDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      id,
      agencyId: AGENCY,
      subAccountId: SA,
      createdByUid: "uid_admin",
      enabled: true,
      allowedOrigins: [VELO],
      maxReviews: 12,
    });
    expect(docs[0].createdAt).toBeInstanceOf(Date);
    expect(docs[0].updatedAt).toBeInstanceOf(Date);
    expect(meta()).toMatchObject({ publicId: id, enabled: true, allowedOrigins: [VELO], maxReviews: 12 });
  });

  it("keeps the same publicId (and creator) on a later save", async () => {
    const first = (await put(CONFIG)).body.widget as Json;
    mem.seed(`subAccounts/${SA}/subAccountMembers/uid_admin2`, { status: "active", role: "admin", subAccountRole: "admin" });
    claims.set("uid_admin2", { status: "active", agencyId: AGENCY, agencyRole: null });
    const second = (await put({ ...CONFIG, enabled: false, maxReviews: 5 }, "uid_admin2")).body.widget as Json;
    expect(second.publicId).toBe(first.publicId);
    expect(widgetDocs()).toHaveLength(1);
    expect(widgetDocs()[0]).toMatchObject({ enabled: false, maxReviews: 5, createdByUid: "uid_admin" });
  });

  it("gives two sub-accounts two unrelated ids", async () => {
    const a = (await put(CONFIG)).body.widget as Json;
    const b = (await put(CONFIG, "uid_other_admin", OTHER_SA)).body.widget as Json;
    expect(a.publicId).not.toBe(b.publicId);
    expect(widgetDocs().map((d) => d.subAccountId).sort()).toEqual([SA, OTHER_SA]);
  });

  it("defaults maxReviews to 12", async () => {
    const { body } = await put({ enabled: true, allowedOrigins: [] });
    expect((body.widget as Json).maxReviews).toBe(12);
  });
});

describe("allowed origins are normalised to scheme://host[:port]", () => {
  it("lower-cases the host and drops a bare trailing slash and a default port", async () => {
    const { body } = await put({
      ...CONFIG,
      allowedOrigins: [" HTTPS://WWW.VelocityFibre.co.za/ ", "https://shop.example.com:443", "https://shop.example.com:8443"],
    });
    expect((body.widget as Json).allowedOrigins).toEqual([VELO, "https://shop.example.com", "https://shop.example.com:8443"]);
  });

  it("accepts plain http only for localhost and 127.0.0.1 (dev)", async () => {
    const { status, body } = await put({ ...CONFIG, allowedOrigins: ["http://localhost:4401", "http://127.0.0.1:4401"] });
    expect(status).toBe(200);
    expect((body.widget as Json).allowedOrigins).toEqual(["http://localhost:4401", "http://127.0.0.1:4401"]);
  });

  it("drops duplicates after normalising", async () => {
    const { body } = await put({ ...CONFIG, allowedOrigins: [VELO, `${VELO}/`, "HTTPS://www.velocityfibre.co.za"] });
    expect((body.widget as Json).allowedOrigins).toEqual([VELO]);
  });

  it.each([
    ["http://www.velocityfibre.co.za", "https_required"],
    ["https://www.velocityfibre.co.za/reviews", "path"],
    ["https://www.velocityfibre.co.za?x=1", "path"],
    ["https://www.velocityfibre.co.za#top", "path"],
    ["https://*.velocityfibre.co.za", "wildcard"],
    ["*", "wildcard"],
    ["https://user:pw@www.velocityfibre.co.za", "credentials"],
    ["ftp://www.velocityfibre.co.za", "scheme"],
    ["www.velocityfibre.co.za", "not_a_url"],
    ["null", "not_a_url"],
    [42, "not_a_string"],
  ])("rejects %s (%s), writing nothing", async (value, reason) => {
    const { status, body } = await put({ ...CONFIG, allowedOrigins: [VELO, value] });
    expect(status).toBe(400);
    expect(body.code).toBe("invalid_origins");
    expect(body.details).toEqual([{ index: 1, value: String(value), reason }]);
    expect(widgetDocs()).toHaveLength(0);
    expect(meta()).toBeUndefined();
  });

  it("allows at most 10", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `https://site${i}.example.com`);
    const { status, body } = await put({ ...CONFIG, allowedOrigins: eleven });
    expect(status).toBe(400);
    expect(body.code).toBe("too_many_origins");
    expect((await put({ ...CONFIG, allowedOrigins: eleven.slice(0, 10) })).status).toBe(200);
  });
});

describe("the rest of the body", () => {
  it.each([0, 51, 1.5, "12", null])("rejects maxReviews %s", async (maxReviews) => {
    const { status, body } = await put({ ...CONFIG, maxReviews });
    expect(status).toBe(400);
    expect(body.code).toBe("invalid_body");
    expect(widgetDocs()).toHaveLength(0);
  });

  it("accepts the bounds 1 and 50", async () => {
    expect((await put({ ...CONFIG, maxReviews: 1 })).status).toBe(200);
    expect((await put({ ...CONFIG, maxReviews: 50 })).status).toBe(200);
  });

  it.each([
    [{ allowedOrigins: [VELO] }],
    [{ enabled: "yes", allowedOrigins: [VELO] }],
    [{ enabled: true }],
    [{ enabled: true, allowedOrigins: VELO }],
    [[CONFIG]],
    ["not json"],
  ])("rejects a malformed body %j", async (bad) => {
    const res = await PUT(
      asUser(`${BASE}/${SA}/gbp/widget`, "uid_admin", "PUT", typeof bad === "string" ? bad : JSON.stringify(bad)),
      params(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).code).toBe("invalid_body");
  });

  it("has NO rating filter: a body with minRating is refused and nothing is stored", async () => {
    const { status, body } = await put({ ...CONFIG, minRating: 4 });
    expect(status).toBe(400);
    expect(body.code).toBe("invalid_body");
    expect(widgetDocs()).toHaveLength(0);
    await put(CONFIG);
    expect((await put({ ...CONFIG, minRating: 4 })).status).toBe(400);
    expect(Object.keys(widgetDocs()[0])).not.toContain("minRating");
    expect(Object.keys(meta()!)).not.toContain("minRating");
  });
});

describe("who may configure it", () => {
  it.each([
    ["a collaborator", "uid_collab"],
    ["an admin of another sub-account", "uid_other_admin"],
    ["a signed-in non-member", "uid_stranger"],
  ])("refuses %s on every method, writing nothing", async (_label, uid) => {
    await put(CONFIG);
    const before = JSON.stringify(widgetDocs());
    expect((await get(uid)).status).toBe(403);
    expect((await put({ ...CONFIG, enabled: false }, uid)).status).toBe(403);
    expect((await rotate(uid)).status).toBe(403);
    expect((await del(uid)).status).toBe(403);
    expect(JSON.stringify(widgetDocs())).toBe(before);
  });

  it("refuses GET, PUT and rotate with the agency gate off — but still allows DELETE", async () => {
    await put(CONFIG);
    gateOff();
    for (const res of [await get(), await put(CONFIG), await rotate()]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("gate_off");
    }
    expect(widgetDocs()).toHaveLength(1);
    expect((await del()).status).toBe(200);
    expect(widgetDocs()).toHaveLength(0);
    expect(meta()).toBeNull();
  });
});

describe("GET", () => {
  it("returns null before a widget exists, then the widget", async () => {
    expect((await get()).body).toEqual({ widget: null });
    const created = (await put(CONFIG)).body.widget as Json;
    expect((await get()).body).toEqual({ widget: created });
  });
});

describe("rotate", () => {
  it("issues a new id with the same config, and deletes the old doc", async () => {
    const old = (await put(CONFIG)).body.widget as Json;
    const { status, body } = await rotate();
    expect(status).toBe(200);
    const fresh = body.widget as Json;
    expect(fresh.publicId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(fresh.publicId).not.toBe(old.publicId);
    expect(fresh).toMatchObject({ enabled: true, allowedOrigins: [VELO], maxReviews: 12 });
    expect(widgetDocs().map((d) => d.id)).toEqual([fresh.publicId]);
    expect(widgetDocs()[0]).toMatchObject({ agencyId: AGENCY, subAccountId: SA });
    expect(meta()).toMatchObject({ publicId: fresh.publicId });
  });

  it("is a 404 when there is no widget to rotate", async () => {
    const { status, body } = await rotate();
    expect(status).toBe(404);
    expect(body.code).toBe("no_widget");
    expect(widgetDocs()).toHaveLength(0);
  });
});

describe("DELETE (revoke)", () => {
  it("deletes the doc and clears the meta, and is idempotent", async () => {
    await put(CONFIG);
    expect((await del()).body).toEqual({ ok: true });
    expect(widgetDocs()).toHaveLength(0);
    expect(meta()).toBeNull();
    expect((await del()).status).toBe(200);
  });

  it("never touches another sub-account's widget", async () => {
    await put(CONFIG, "uid_other_admin", OTHER_SA);
    await put(CONFIG);
    await del();
    expect(widgetDocs().map((d) => d.subAccountId)).toEqual([OTHER_SA]);
    expect(meta(OTHER_SA)).toMatchObject({ enabled: true });
  });
});
