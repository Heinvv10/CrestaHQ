import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * withApiAuth's DEFAULT idempotency storage rule, which every existing v1
 * route relies on (only the agent tools route overrides it): a 4xx outcome
 * is stored and replayed, a 5xx is never stored so a retry runs again. A 429
 * is the one 4xx that is not an outcome: it says "not done, try later".
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { withApiAuth } = await import("./auth");
const { mintApiKey } = await import("./keys");

let key = "";
const handler = vi.fn(async (): Promise<NextResponse> => NextResponse.json({}));
const route = withApiAuth(() => handler(), { requireScope: "admin" });
const post = (k: string) =>
  route(
    new Request("http://localhost/api/v1/things", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "idempotency-key": k, "content-type": "application/json" },
      body: "{}",
    }),
    { params: undefined }
  );

beforeEach(() => {
  mem.clear();
  handler.mockReset();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true });
  const m = mintApiKey("live");
  mem.seed("subAccounts/sa1/apiKeys/k1", {
    subAccountId: "sa1", agencyId: "ag1", name: "k", mode: "live",
    prefix: m.prefix, hashedSecret: m.hashedSecret, scopes: ["admin"], revokedAt: null, createdAt: new Date(),
  });
  key = m.rawKey;
});

it("a 4xx outcome is stored: the retry replays it without running the handler again", async () => {
  handler.mockResolvedValue(NextResponse.json({ error: { code: "conflict" } }, { status: 409 }));
  expect((await post("four")).status).toBe(409);
  expect((await post("four")).status).toBe(409);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(mem.list("subAccounts/sa1/apiIdempotency")).toHaveLength(1);
});

it("a 5xx outcome is never stored: the retry runs the handler again", async () => {
  handler.mockResolvedValue(NextResponse.json({ error: { code: "upstream" } }, { status: 502 }));
  expect((await post("five")).status).toBe(502);
  expect((await post("five")).status).toBe(502);
  expect(handler).toHaveBeenCalledTimes(2);
  expect(mem.list("subAccounts/sa1/apiIdempotency")).toEqual([]);
});

it("a 429 is never stored: the retry the response asks for runs the handler again", async () => {
  handler.mockResolvedValueOnce(NextResponse.json({ error: { code: "workflow_enrolment_cap" } }, { status: 429 }));
  handler.mockResolvedValueOnce(NextResponse.json({ ok: true }, { status: 201 }));
  expect((await post("later")).status).toBe(429);
  expect(mem.list("subAccounts/sa1/apiIdempotency")).toEqual([]);
  expect((await post("later")).status).toBe(201);
  expect(handler).toHaveBeenCalledTimes(2);
});
