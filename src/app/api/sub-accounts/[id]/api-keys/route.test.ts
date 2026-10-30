import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/**
 * POST /api/sub-accounts/[id]/api-keys — scope validation. The `agent`
 * scope (Agent API v1 PR1) is mutually exclusive with `admin` and
 * `forms-ingest`: mixing scopes on one key must 400, not silently drop or
 * merge them.
 */

const m = vi.hoisted(() => ({
  admin: vi.fn(),
  mint: vi.fn(),
  hash: vi.fn(),
  create: vi.fn(),
  subData: null as Record<string, unknown> | null,
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: m.admin,
}));
vi.mock("@/lib/api/keys", () => ({
  mintApiKey: m.mint,
  hashApiKey: m.hash,
}));
vi.mock("@/lib/firestore/api-keys", () => ({
  createApiKey: m.create,
  docToResponse: (doc: unknown) => doc,
  listApiKeys: vi.fn(),
}));
const db = {
  doc: (path: string) => ({
    path,
    get: async () => ({ exists: m.subData !== null, data: () => m.subData }),
  }),
};
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => db }));

import { POST } from "./route";

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("https://example.com/api/sub-accounts/sa1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "sa1" }) },
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.admin.mockResolvedValue({ uid: "u1" });
  m.subData = {
    agencyId: "ag1",
    apiAccessEnabledByAgency: true,
    agentApiEnabledByAgency: true,
  };
  m.mint.mockReturnValue({ prefix: "abc123", rawKey: "lsk_live_abc123_secret" });
  m.hash.mockReturnValue("hashed");
  m.create.mockResolvedValue({
    id: "key1",
    subAccountId: "sa1",
    agencyId: "ag1",
    name: "Test",
    mode: "live",
    prefix: "abc123",
    hashedSecret: "hashed",
    scopes: ["agent"],
    createdByUid: "u1",
    createdAt: new Date(),
    lastUsedAt: null,
    revokedAt: null,
    revokedByUid: null,
  });
});

it("mints an agent-scope key on its own", async () => {
  const res = await post({ name: "Agent key", mode: "live", scopes: ["agent"] });
  expect(res.status).toBe(200);
  expect(m.create).toHaveBeenCalledWith(
    expect.objectContaining({ scopes: ["agent"] }),
  );
});

it("refuses agent + admin on one key", async () => {
  const res = await post({ name: "Bad key", mode: "live", scopes: ["agent", "admin"] });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toMatch(/admin.*agent|agent.*admin/i);
  expect(m.create).not.toHaveBeenCalled();
});

it("refuses agent + forms-ingest on one key", async () => {
  const res = await post({
    name: "Bad key",
    mode: "live",
    scopes: ["agent", "forms-ingest"],
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toMatch(/agent.*forms-ingest|forms-ingest.*agent/i);
  expect(m.create).not.toHaveBeenCalled();
});

it("still refuses admin + forms-ingest (pre-existing exclusivity)", async () => {
  const res = await post({
    name: "Bad key",
    mode: "live",
    scopes: ["admin", "forms-ingest"],
  });
  expect(res.status).toBe(400);
  expect(m.create).not.toHaveBeenCalled();
});

it("refuses an agent-scope mint while the agent gate is off", async () => {
  m.subData = { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: false };
  const res = await post({ name: "Agent key", mode: "live", scopes: ["agent"] });
  expect(res.status).toBe(403);
  expect(m.create).not.toHaveBeenCalled();
});

it("refuses a non-admin", async () => {
  m.admin.mockResolvedValue(
    NextResponse.json({ error: "Sub-account admin only" }, { status: 403 }),
  );
  const res = await post({ name: "x", mode: "live", scopes: ["agent"] });
  expect(res.status).toBe(403);
  expect(m.create).not.toHaveBeenCalled();
});
