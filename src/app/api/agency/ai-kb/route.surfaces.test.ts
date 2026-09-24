import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiSuiteCapability } from "@/lib/ai-suite/capabilities";

/**
 * The KB review prompt lists the assistant's capabilities so cards can
 * mention them. It must list only what the chat surface offers — an
 * agent-only capability is not something the in-app assistant can do.
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireAgencyOwnerAny: async () => ({ uid: "u1", email: "a@example.com", agencyId: "ag1" }),
}));
vi.mock("@/lib/setup/env-file", () => ({ isLocalDev: () => true }));
vi.mock("@/lib/ai-suite/model", () => ({
  aiSuiteIsConfigured: () => true,
  aiSuiteModel: () => "test-model",
}));

const { AI_SUITE_CAPABILITIES } = await import("@/lib/ai-suite/capabilities");
const { POST } = await import("./route");

const fixture: AiSuiteCapability = {
  name: "__agent_only_fixture",
  level: "sub-account",
  requiredRole: "subAccountMember",
  surfaces: ["agent"],
  menuLabel: "fixture",
  description: "fixture",
  parameters: { type: "object", properties: {} },
  validate: () => ({ ok: true, args: {} }),
  summarize: () => "fixture",
  execute: async () => ({ resultText: "ran" }),
};

afterEach(() => {
  const i = AI_SUITE_CAPABILITIES.indexOf(fixture);
  if (i >= 0) AI_SUITE_CAPABILITIES.splice(i, 1);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/agency/ai-kb", () => {
  it("omits agent-only capabilities from the review prompt", async () => {
    AI_SUITE_CAPABILITIES.push(fixture);
    vi.stubEnv("NODE_ENV", "development");
    let prompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        prompt = JSON.parse(init.body).messages[0].content;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"changes":[]}' } }] })
        );
      })
    );
    const res = await POST(new Request("http://localhost/api/agency/ai-kb", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(prompt).toContain('"name": "find_contacts"');
    expect(prompt).not.toContain("__agent_only_fixture");
  });
});
