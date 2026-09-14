import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PUT /api/sub-accounts/[id]/reputation/ai-settings — the reply guidelines
 * the AI draft follows (SP5 c, ledger R6). Real tenancy and gate, Firestore in
 * memory.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { AGENCY, OTHER_SA, SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { GET, PUT } from "./route";
import { DRAFT_DAILY_CAP } from "@/lib/reputation/draft";
import { DAILY_AI_CALL_CAP } from "@/lib/reputation/sentiment-calls";

const put = async (body: unknown, uid = "uid_admin", sa = SA) => {
  const res = await PUT(asUser(`http://127.0.0.1:3100/api/sub-accounts/${sa}/reputation/ai-settings`, uid, "PUT", typeof body === "string" ? body : JSON.stringify(body)), {
    params: Promise.resolve({ id: sa }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const config = (sa = SA) => mem.read(`subAccounts/${sa}`)?.reviewsAiConfig as Record<string, unknown> | null | undefined;
const patchSub = (patch: Record<string, unknown>, sa = SA) => mem.seed(`subAccounts/${sa}`, { ...mem.read(`subAccounts/${sa}`)!, ...patch });

const ORIGINAL = { ...process.env };
const get = async (uid = "uid_collab") => {
  const res = await GET(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/reputation/ai-settings`, uid), { params: Promise.resolve({ id: SA }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  resetSync();
  process.env.REVIEWS_AI_PROVIDER = "fake";
  process.env.REVIEWS_AI_FAKE_AGENCY_ID = AGENCY;
  patchSub({ reviewsAiEnabledByAgency: true });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("saving guidelines", () => {
  it("stores the trimmed text with who and when, and returns it", async () => {
    const { status, body } = await put({ replyGuidelines: "  Friendly, sign off as The Fixture Team.  " });
    expect(status).toBe(200);
    expect(config()).toMatchObject({ replyGuidelines: "Friendly, sign off as The Fixture Team.", updatedByUid: "uid_admin" });
    expect(config()?.updatedAt).toBeInstanceOf(Date);
    expect(body).toMatchObject({ reviewsAiConfig: { replyGuidelines: "Friendly, sign off as The Fixture Team." } });
  });

  it("accepts exactly 1000 characters, and an empty value clears them", async () => {
    expect((await put({ replyGuidelines: "x".repeat(1000) })).status).toBe(200);
    expect((await put({ replyGuidelines: "" })).status).toBe(200);
    expect(config()?.replyGuidelines).toBe("");
  });

  it.each([
    [{ replyGuidelines: "x".repeat(1001) }],
    [{ replyGuidelines: 42 }],
    [{ replyGuidelines: null }],
    [{}],
    [{ replyGuidelines: "ok", autoReply: true }],
    ["not json"],
    [["ok"]],
  ])("refuses %j with 400 invalid_body, writing nothing", async (bad) => {
    const res = await put(bad);
    expect([res.status, res.body.code]).toEqual([400, "invalid_body"]);
    expect(config()).toBeUndefined();
  });
});

describe("who may", () => {
  it.each([
    ["a collaborator", "uid_collab"],
    ["a non-member", "uid_stranger"],
    ["another sub-account's admin", "uid_other_admin"],
  ])("refuses %s (403)", async (_l, uid) => {
    expect((await put({ replyGuidelines: "x" }, uid)).status).toBe(403);
    expect(config()).toBeUndefined();
  });

  it("needs the Reviews AI gate (403 ai_gate_off)", async () => {
    patchSub({ reviewsAiEnabledByAgency: false });
    const res = await put({ replyGuidelines: "x" });
    expect([res.status, res.body.code]).toEqual([403, "ai_gate_off"]);
    expect(config()).toBeUndefined();
  });

  it("writes only its own sub-account", async () => {
    await put({ replyGuidelines: "mine" });
    expect(config(OTHER_SA)).toBeUndefined();
  });
});

describe("GET — what the Settings card shows", () => {
  it("any member reads the gate, whether AI is configured here, and the guidelines", async () => {
    await put({ replyGuidelines: "Be kind." });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({ enabled: true, configured: true, replyGuidelines: "Be kind.", draftDailyCap: DRAFT_DAILY_CAP, dailyCap: DAILY_AI_CALL_CAP });
    expect(typeof body.updatedAt).toBe("string");
  });

  it("says not configured, gate off, and no guidelines — honestly", async () => {
    delete process.env.REVIEWS_AI_PROVIDER;
    delete process.env.OPENROUTER_API_KEY;
    patchSub({ reviewsAiEnabledByAgency: false });
    expect((await get()).body).toEqual({
      enabled: false, configured: false, replyGuidelines: "", updatedAt: null, draftDailyCap: DRAFT_DAILY_CAP, dailyCap: DAILY_AI_CALL_CAP,
    });
  });

  it("refuses a non-member and another sub-account's admin", async () => {
    expect((await get("uid_stranger")).status).toBe(403);
    expect((await get("uid_other_admin")).status).toBe(403);
  });
});
