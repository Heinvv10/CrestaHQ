import { describe, expect, it, vi } from "vitest";

/**
 * The gate sets behind `set_sub_account_gate` (AGENCY_AGENT_API_PLAN.md D3,
 * A4a-1), over the RUNTIME `FEATURE_GATES` keys: every key sits in exactly
 * one of DIRECT_GATES, PROPOSAL_GATES and ENABLE_REFUSED, so a gate added to
 * none fails here until someone classifies it on purpose — and meanwhile it
 * routes to a proposal. The named sets name only real keys (get-leads only
 * while it is not parked). And the surfaces: `set_feature_gate` is chat-only,
 * `set_sub_account_gate` agent-only.
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

const { FEATURE_GATES } = await import("./helpers");
const { DIRECT_GATES, PROPOSAL_GATES, ENABLE_REFUSED, gateRoute } = await import("./agency-gates");
const { availableOn, getCapability } = await import("@/lib/ai-suite/capabilities");
const { AGENCY_AGENT_CALLABLE, agencyAgentCallable } = await import("@/lib/api/agent-tools-listing");
const { GET_LEADS_PARKED } = await import("@/lib/get-leads/business-types");

const keys = Object.keys(FEATURE_GATES);
const SETS = { DIRECT_GATES, PROPOSAL_GATES, ENABLE_REFUSED };

describe("the partition over the runtime FEATURE_GATES keys", () => {
  it.each(keys)("%s is in exactly one set", (gate) => {
    const homes = Object.entries(SETS).filter(([, set]) => set.has(gate)).map(([name]) => name);
    expect(homes, `${gate}: classify it in agency-gates.ts`).toHaveLength(1);
  });

  it("the named sets name only real keys, get-leads only while it is not parked", () => {
    for (const [name, set] of Object.entries(SETS)) {
      for (const gate of set) {
        if (gate === "get-leads" && GET_LEADS_PARKED) continue;
        expect(keys, `${name} names ${gate}`).toContain(gate);
      }
    }
  });

  it("the sets the plan names, exactly", () => {
    expect([...DIRECT_GATES].sort()).toEqual(
      ["community", "get-leads", "google-calendar", "labs", "payments", "prospecting", "social-planner", "webinars", "website"],
    );
    expect([...PROPOSAL_GATES].sort()).toEqual([
      "ai-suite", "broadcasts", "google", "inbound-voice", "meta-agent", "meta-inbox", "missed-call-text-back",
      "outbound-voice", "reviews-ai", "sms-agent", "web-chat", "whatsapp",
    ]);
  });

  it("ENABLE_REFUSED is agent-api, api-access and every assistantMayEnable: false key", () => {
    const noEnable = keys.filter((k) => FEATURE_GATES[k]!.assistantMayEnable === false);
    expect([...ENABLE_REFUSED].sort()).toEqual([...new Set(["agent-api", "api-access", ...noEnable])].sort());
    expect(noEnable).toContain("reviews-auto-reply");
  });

  it("names agent-api and api-access itself: they stay refused with every assistantMayEnable flag stripped", async () => {
    vi.resetModules();
    vi.doMock("./helpers", async (orig) => {
      const real = await orig<typeof import("./helpers")>();
      const stripped = Object.entries(real.FEATURE_GATES).map(([k, { field, label }]) => [k, { field, label }]);
      return { ...real, FEATURE_GATES: Object.fromEntries(stripped) };
    });
    try {
      const fresh = await import("./agency-gates");
      expect([...fresh.ENABLE_REFUSED].sort()).toEqual(["agent-api", "api-access"]);
    } finally {
      vi.doUnmock("./helpers");
      vi.resetModules();
    }
  });
});

describe("gateRoute", () => {
  it("enabling an ENABLE_REFUSED gate is refused; switching it off is a proposal", () => {
    for (const gate of ENABLE_REFUSED) {
      expect(gateRoute(gate, true), gate).toBe("refused");
      expect(gateRoute(gate, false), gate).toBe("proposal");
    }
  });

  it("a DIRECT gate may be direct both ways; a PROPOSAL gate never", () => {
    for (const gate of DIRECT_GATES) for (const on of [true, false]) expect(gateRoute(gate, on), gate).toBe("direct");
    for (const gate of PROPOSAL_GATES) for (const on of [true, false]) expect(gateRoute(gate, on), gate).toBe("proposal");
  });

  it("a gate in no set defaults to a proposal", () => {
    expect(gateRoute("a-gate-added-tomorrow", true)).toBe("proposal");
    expect(gateRoute("a-gate-added-tomorrow", false)).toBe("proposal");
  });
});

describe("surfaces", () => {
  it("set_feature_gate is chat-only, and not agency-agent-callable even named in the set", () => {
    const cap = getCapability("set_feature_gate")!;
    expect(cap.surfaces).toEqual(["chat"]);
    expect(availableOn(cap, "agent")).toBe(false);
    const set = AGENCY_AGENT_CALLABLE as Set<string>;
    set.add(cap.name);
    try {
      expect(agencyAgentCallable(cap)).toBe(false);
    } finally {
      set.delete(cap.name);
    }
  });

  it("set_sub_account_gate is agent-only and agency-agent-callable", () => {
    const cap = getCapability("set_sub_account_gate")!;
    expect(cap.level).toBe("agency");
    expect(cap.surfaces).toEqual(["agent"]);
    expect(availableOn(cap, "chat")).toBe(false);
    expect(agencyAgentCallable(cap)).toBe(true);
  });
});
