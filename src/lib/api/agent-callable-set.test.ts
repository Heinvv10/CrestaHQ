import { describe, expect, it, vi } from "vitest";
import type { AgencyApiAuthContext, ApiAuthContext } from "@/lib/api/auth";

/**
 * What an agent key may call, computed from the REAL registry
 * (AGENCY_AGENT_API_PLAN.md A3a): the agency-level set is exactly the named
 * one — adding a capability to it means editing this test on purpose — no
 * `*_in_sub_account` variant is callable on either level, and the tools
 * listing gives an agency key a required `subAccountId` on every
 * sub-account tool while a sub-account key sees the v1 set untouched.
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

const { AI_SUITE_CAPABILITIES, getCapability } = await import("@/lib/ai-suite/capabilities");
const { AGENCY_AGENT_CALLABLE, agencyAgentCallable, agentCallable, isAgentReadTool, isAgentWriteTool } = await import(
  "./agent-dispatch"
);
const { agentToolsFor } = await import("./agent-tools-listing");

const EXPECTED_AGENCY_CALLABLE = ["list_sub_accounts", "sub_account_stats"];

const fields = {
  agencyId: "ag1", keyId: "k1", keyPrefix: "abcd1234", keyName: "k", mode: "live" as const,
  scopes: ["agent" as const], enrolmentCapPerHour: 50, requestId: "r", apiVersion: "2026-01-01",
};
const subKey: ApiAuthContext = { ...fields, level: "sub-account", subAccountId: "sa1", keyLevel: "sub-account" };
const agencyKey: AgencyApiAuthContext = { ...fields, level: "agency", subAccountId: null, keyLevel: "agency" };

type Schema = { properties?: Record<string, unknown>; required?: string[] };

describe("the agency-callable set", () => {
  it("computed from the registry equals the named set exactly", () => {
    expect(AI_SUITE_CAPABILITIES.filter(agencyAgentCallable).map((c) => c.name).sort()).toEqual(EXPECTED_AGENCY_CALLABLE);
    expect([...AGENCY_AGENT_CALLABLE].sort()).toEqual(EXPECTED_AGENCY_CALLABLE);
  });
});

describe("read/write classification covers the agency level", () => {
  it("every agency-callable member is a plain read: readonly, no approval class", () => {
    for (const name of AGENCY_AGENT_CALLABLE) {
      const cap = getCapability(name)!;
      expect(cap.readonly, name).toBe(true);
      expect(cap.approval ?? cap.approvalFor, name).toBeUndefined();
    }
  });

  it("so isAgentReadTool counts them as reads (never cached), isAgentWriteTool as no write", () => {
    for (const name of AGENCY_AGENT_CALLABLE) {
      expect(isAgentReadTool(name), name).toBe(true);
      expect(isAgentWriteTool(name), name).toBe(false);
    }
  });
});

describe("no *_in_sub_account variant is callable on either level", () => {
  const variants = AI_SUITE_CAPABILITIES.filter((c) => c.name.endsWith("_in_sub_account"));

  it("iterating the registry", () => {
    expect(variants.length).toBeGreaterThan(10);
    for (const v of variants) {
      expect(agentCallable(v), v.name).toBe(false);
      expect(agencyAgentCallable(v), v.name).toBe(false);
      expect(v.surfaces, v.name).not.toContain("agent");
    }
  });

  it("refused by name, even shaped like a callable capability or named in the set", () => {
    const base = getCapability("find_contacts")!;
    expect(agentCallable(base)).toBe(true);
    expect(agentCallable({ ...base, name: "find_contacts_in_sub_account" })).toBe(false);
    const set = AGENCY_AGENT_CALLABLE as Set<string>;
    set.add("find_contacts_in_sub_account");
    try {
      expect(agencyAgentCallable(getCapability("find_contacts_in_sub_account")!)).toBe(false);
    } finally {
      set.delete("find_contacts_in_sub_account");
    }
  });
});

describe("agentToolsFor", () => {
  it("a sub-account key sees the v1 set, schemas untouched", () => {
    const tools = agentToolsFor(subKey);
    const v1 = AI_SUITE_CAPABILITIES.filter(agentCallable);
    expect(tools.map((t) => t.cap)).toEqual(v1);
    tools.forEach((t, i) => expect(t.parameters).toBe(v1[i]!.parameters));
  });

  it("an agency key: the agency set as-is, and a required subAccountId on every sub-account tool", () => {
    const tools = agentToolsFor(agencyKey);
    const names = tools.map((t) => t.cap.name);
    expect(names.filter((n) => getCapability(n)!.level === "agency").sort()).toEqual(EXPECTED_AGENCY_CALLABLE);
    expect(names.filter((n) => getCapability(n)!.level === "sub-account")).toEqual(
      AI_SUITE_CAPABILITIES.filter(agentCallable).map((c) => c.name),
    );
    for (const { cap, parameters } of tools) {
      const schema = parameters as Schema;
      if (cap.level === "agency") {
        expect(parameters).toBe(cap.parameters);
        continue;
      }
      expect(schema.required, cap.name).toContain("subAccountId");
      expect(schema.properties?.subAccountId, cap.name).toMatchObject({ type: "string" });
      // The registry's own schema is not mutated: a sub-account key still sees it bare.
      expect((cap.parameters as Schema).required ?? [], cap.name).not.toContain("subAccountId");
    }
  });
});
