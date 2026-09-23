import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Test this prompt" spends the agency's OpenRouter key on every click and is
 * not metered into the sub-account's token counters, so it carries its own
 * per-sub-account budget. The tenancy guard is real (in-memory Firestore).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const callAi = vi.hoisted(() => vi.fn(async () => ({ text: "hi", model: "m", totalTokens: 3 })));
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => true, callAi }));
vi.mock("@/lib/comms/ai/agent", () => ({
  getAgentProfile: async () => ({
    systemPrompt: "You are helpful.",
    businessName: "Fixture",
    hoursStart: null,
    hoursEnd: null,
    timezone: "Africa/Johannesburg",
    escalationKeywords: [],
    escalationNotifyEmail: null,
  }),
  getChannelConfig: async () => null,
}));

const { mem, claims } = await import("@/test/gbp-sync-store");
const { POST } = await import("./route");

const LIMIT = 60;
function test(sa: string) {
  return POST(
    new Request(`https://app.test/api/sub-accounts/${sa}/ai-agent/test`, {
      method: "POST",
      headers: { "x-user-uid": "owner", "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    }),
    { params: Promise.resolve({ id: sa }) },
  );
}

beforeEach(() => {
  mem.clear();
  callAi.mockClear();
  claims.set("owner", { status: "active", agencyRole: "owner", agencyId: "ag1" });
  mem.seed("subAccounts/sa-rl-1", { agencyId: "ag1", name: "One" });
  mem.seed("subAccounts/sa-rl-2", { agencyId: "ag1", name: "Two" });
});

describe("POST /ai-agent/test rate limit", () => {
  it("429s a sub-account past its hourly budget without calling the model; another sub-account is unaffected", async () => {
    for (let i = 0; i < LIMIT; i++) expect((await test("sa-rl-1")).status).toBe(200);
    callAi.mockClear();
    const res = await test("sa-rl-1");
    expect(res.status).toBe(429);
    expect(callAi).not.toHaveBeenCalled();
    expect((await test("sa-rl-2")).status).toBe(200);
  });
});
