import { describe, expect, it, vi } from "vitest";

import manifest from "../../../scripts/agent-coverage.json";

/**
 * The vitest half of the agent coverage gate (AGENCY_AGENT_API_PLAN.md, A1).
 * scripts/check-agent-coverage.mjs proves every route is accounted for; it is
 * zero-dependency, so it cannot load the registry. This proves the other
 * half: every tool name a route maps to is a real capability an agent key
 * can call. Without it, `{ "tools": ["find_contact"] }` (one letter short)
 * would mark a route exposed that no agent can reach.
 *
 * Sub-account keys are the only agent key level today. Agency-level
 * callability (AGENCY_AGENT_CALLABLE) joins this predicate in A3a.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

const { getCapability } = await import("@/lib/ai-suite/capabilities");
const { agentCallable } = await import("@/lib/api/agent-dispatch");

const mapped = Object.entries(manifest.routes as Record<string, { tools?: string[] }>).flatMap(
  ([key, entry]) => (entry.tools ?? []).map((tool) => [key, tool] as const),
);

describe("agent coverage manifest tool names", () => {
  it("maps at least one route to a tool (the table below is not empty)", () => {
    expect(mapped.length).toBeGreaterThan(0);
  });

  it.each(mapped)("%s → %s is a registered, agent-callable tool", (_key, tool) => {
    const cap = getCapability(tool);
    expect(cap, `no capability named ${tool}`).toBeDefined();
    expect(agentCallable(cap!), `${tool} is not callable by an agent key`).toBe(true);
  });
});
