import { afterEach, beforeEach, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { ApiAuthContext } from "@/lib/api/auth";
import type { AiSuiteCapability } from "@/lib/ai-suite/capabilities";

/**
 * Shared setup for the dispatchAgentTool tests (split across
 * `src/lib/api/agent-dispatch*.test.ts` to stay under the 300-line cap). Each
 * test file declares, hoisted:
 *   vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-dispatch-harness")).adminMock());
 * Fixtures are pushed into the real registry and removed after each test.
 */

export const mem = createMemoryFirestore();
export const adminMock = () => ({ getAdminDb: () => mem.db });

export const auth: ApiAuthContext = {
  level: "sub-account",
  agencyId: "ag1",
  subAccountId: "sa1",
  keyId: "key1",
  keyPrefix: "abcd1234",
  keyName: "Agent key",
  mode: "live",
  scopes: ["agent"],
  enrolmentCapPerHour: 50,
  requestId: "req_1",
  apiVersion: "2026-01-01",
};

const injected: AiSuiteCapability[] = [];
export async function inject(
  overrides: Partial<AiSuiteCapability> & { name: string }
): Promise<AiSuiteCapability> {
  const { AI_SUITE_CAPABILITIES } = await import("@/lib/ai-suite/capabilities");
  const cap: AiSuiteCapability = {
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel: "fixture",
    description: "fixture",
    parameters: { type: "object", properties: {} },
    validate: (raw) => ({ ok: true, args: (raw ?? {}) as Record<string, unknown> }),
    summarize: () => "fixture",
    execute: vi.fn(async () => ({ resultText: "ran" })),
    ...overrides,
  };
  AI_SUITE_CAPABILITIES.push(cap);
  injected.push(cap);
  return cap;
}

export function setupDispatchTests() {
  beforeEach(() => {
    mem.clear();
    mem.seed("subAccounts/sa1", { agencyId: "ag1", agentApiEnabledByAgency: true, timezone: "UTC" });
    mem.seed("subAccounts/sa2", { agencyId: "ag1", agentApiEnabledByAgency: true, timezone: "UTC" });
    mem.seed("subAccounts/sa1/apiKeys/key1", { subAccountId: "sa1", revokedAt: null });
  });

  afterEach(async () => {
    const { AI_SUITE_CAPABILITIES } = await import("@/lib/ai-suite/capabilities");
    for (const cap of injected.splice(0)) {
      AI_SUITE_CAPABILITIES.splice(AI_SUITE_CAPABILITIES.indexOf(cap), 1);
    }
  });
}
