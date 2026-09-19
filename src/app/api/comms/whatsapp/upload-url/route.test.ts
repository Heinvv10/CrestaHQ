import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/comms/whatsapp/upload-url — who gets a signed PUT URL, for what,
 * and where it points. The auth helpers are mocked at the seam the send route
 * shares; the signing call is captured so the path and the signed type are
 * checked as Storage would receive them.
 */

const requireUid = vi.fn();
const requireContactAccessible = vi.fn();
let subAccountDoc: Record<string, unknown> | undefined;
let signed: Array<{ path: string; opts: Record<string, unknown> }>;

vi.mock("@/lib/comms/route-auth", () => ({
  requireUid: (...a: unknown[]) => requireUid(...a),
  requireContactAccessible: (...a: unknown[]) => requireContactAccessible(...a),
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminApp: () => ({ name: "test-app" }),
  getAdminDb: () => ({
    doc: () => ({ get: async () => ({ exists: subAccountDoc !== undefined, data: () => subAccountDoc }) }),
  }),
}));
vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({
    bucket: () => ({
      file: (path: string) => ({
        getSignedUrl: async (opts: Record<string, unknown>) => {
          signed.push({ path, opts });
          return [`https://storage.googleapis.com/test-bucket/${path}?X-Goog-Signature=abc`];
        },
      }),
    }),
  }),
}));

import { POST } from "./route";

function post(body: Record<string, unknown>) {
  return POST(
    new Request("https://crm.test/api/comms/whatsapp/upload-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const pdf = { contactId: "c1", contentType: "application/pdf", sizeBytes: 50_000_000 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "test-bucket");
  signed = [];
  subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "cloud" };
  requireUid.mockReturnValue({ uid: "u1", email: "" });
  requireContactAccessible.mockResolvedValue({ id: "c1", agencyId: "ag1", subAccountId: "sa1" });
});

describe("POST /api/comms/whatsapp/upload-url", () => {
  it("issues a 10-minute V4 write URL, signed for the declared type, at a server-derived path", async () => {
    const before = Date.now();
    const res = await post(pdf);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stagedId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(json.uploadUrl).toContain("X-Goog-Signature");
    expect(signed).toHaveLength(1);
    expect(signed[0]!.path).toBe(`whatsapp-staging/ag1/sa1/u1/${json.stagedId}`);
    expect(signed[0]!.opts).toMatchObject({ version: "v4", action: "write", contentType: "application/pdf" });
    const expires = signed[0]!.opts.expires as number;
    expect(expires - before).toBeGreaterThanOrEqual(10 * 60_000);
    expect(expires - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(requireContactAccessible).toHaveBeenCalledWith("u1", "c1");
  });

  it("refuses a caller without access to the contact, and signs nothing", async () => {
    requireContactAccessible.mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    const res = await post(pdf);
    expect(res.status).toBe(403);
    expect(signed).toHaveLength(0);
  });

  it("refuses an unauthenticated caller", async () => {
    requireUid.mockReturnValue(NextResponse.json({ error: "Not authenticated" }, { status: 401 }));
    expect((await post(pdf)).status).toBe(401);
    expect(signed).toHaveLength(0);
  });

  it("ignores every client-supplied path component", async () => {
    const res = await post({
      ...pdf,
      path: "whatsapp-media/ag2/sa2/c9/x",
      agencyId: "ag2",
      subAccountId: "sa2",
      uid: "u2",
      stagedId: "../../evil",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stagedId).not.toBe("../../evil");
    expect(signed[0]!.path).toBe(`whatsapp-staging/ag1/sa1/u1/${json.stagedId}`);
  });

  it("issues a fresh id every time", async () => {
    const a = await (await post(pdf)).json();
    const b = await (await post(pdf)).json();
    expect(a.stagedId).not.toBe(b.stagedId);
  });

  it.each([
    ["a document over Meta's 100 MB", { contentType: "application/pdf", sizeBytes: 100_000_001 }, "media_too_large"],
    ["an image over Meta's 5 MB", { contentType: "image/png", sizeBytes: 5_000_001 }, "media_too_large"],
    ["a type the rail does not send", { contentType: "image/svg+xml", sizeBytes: 10 }, "media_unsupported_type"],
    ["an empty file", { contentType: "application/pdf", sizeBytes: 0 }, "media_invalid"],
    ["a fractional size", { contentType: "application/pdf", sizeBytes: 1.5 }, "media_invalid"],
  ])("refuses %s before signing", async (_l, decl, code) => {
    const res = await post({ contactId: "c1", ...decl });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(code);
    expect(signed).toHaveLength(0);
  });

  it("holds the bridge rail to its 8 MiB", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "bridge" };
    const res = await post({ contactId: "c1", contentType: "application/pdf", sizeBytes: (8 << 20) + 1 });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_too_large");
    expect(signed).toHaveLength(0);
  });

  it("refuses on Twilio, which carries no file", async () => {
    subAccountDoc = { whatsappEnabledByAgency: true, whatsappProvider: "twilio" };
    const res = await post(pdf);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_unsupported_rail");
    expect(signed).toHaveLength(0);
  });

  it("refuses when the agency has WhatsApp off", async () => {
    subAccountDoc = { whatsappEnabledByAgency: false, whatsappProvider: "cloud" };
    expect((await post(pdf)).status).toBe(403);
    expect(signed).toHaveLength(0);
  });

  it("400s a body missing its fields", async () => {
    expect((await post({ contactId: "c1", contentType: "application/pdf" })).status).toBe(400);
    expect((await post({ contactId: "c1", sizeBytes: 3 })).status).toBe(400);
    expect(signed).toHaveLength(0);
  });

  it("503s when no bucket is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "");
    expect((await post(pdf)).status).toBe(503);
  });
});
