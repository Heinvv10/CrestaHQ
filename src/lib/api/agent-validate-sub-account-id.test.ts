import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth as subKey, mem, setupDispatchTests } from "@/test/agent-dispatch-harness";
import type { AgencyApiAuthContext } from "@/lib/api/auth";

/**
 * The validator contract behind dispatch's post-validate check (A3a breaker,
 * carried forward to A4a). Reach is checked on the `subAccountId` an agency
 * key sends; dispatch then compares `validated.args.subAccountId` with it.
 * A validator that renamed, rewrote or (where the tool declares it) dropped
 * the id would hand execute a target reach never checked. Iterates the live
 * registry, so a new member is covered the day it joins.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-dispatch-harness")).adminMock());

const { dispatchAgentTool, agencyAgentCallable, agentCallable } = await import("./agent-dispatch");
const { AI_SUITE_CAPABILITIES } = await import("@/lib/ai-suite/capabilities");

setupDispatchTests();

/** Mixed case, so a case-folding rewrite cannot match it. */
const SENTINEL = "Sa_Contract_9Zq";
/** Whatever else a member needs to validate. A new member that does not
 *  validate with these fails below until its entry is added here. */
const OTHER_ARGS: Record<string, Record<string, unknown>> = {
  sub_account_stats: { subAccountName: "Acme" },
};
const declares = (cap: { parameters: unknown }) =>
  "subAccountId" in ((cap.parameters as { properties?: object }).properties ?? {});
/** Every value but `subAccountId` itself, as one lower-cased string. */
const elsewhere = (args: Record<string, unknown>) => {
  const { subAccountId: _id, ...rest } = args;
  return JSON.stringify(rest).toLowerCase();
};

describe("agency-callable validators keep subAccountId exactly where they got it", () => {
  const members = AI_SUITE_CAPABILITIES.filter(agencyAgentCallable);

  it("the set is non-empty", () => {
    expect(members.length).toBeGreaterThan(0);
  });

  it.each(members.map((c) => [c.name, c] as const))("%s", (name, cap) => {
    const validated = cap.validate({ ...OTHER_ARGS[name], subAccountId: SENTINEL });
    expect(validated, `${name} must validate; add its other args to OTHER_ARGS`).toMatchObject({ ok: true });
    if (!validated.ok) return;
    // Declared → returned unchanged; undeclared → dropped or unchanged.
    if (declares(cap) || "subAccountId" in validated.args) {
      expect(validated.args.subAccountId, name).toBe(SENTINEL);
    }
    // Never moved under another key, rewritten or not.
    expect(elsewhere(validated.args), name).not.toContain(SENTINEL.toLowerCase());
  });

  // A trimming validator (str()) would hand execute an id reach never saw.
  it.each(members.map((c) => [c.name, c] as const))("%s: a padded id is kept exactly or refused, never trimmed", (name, cap) => {
    const padded = ` ${SENTINEL} `;
    const validated = cap.validate({ ...OTHER_ARGS[name], subAccountId: padded });
    if (!validated.ok) return;
    if ("subAccountId" in validated.args) expect(validated.args.subAccountId, name).toBe(padded);
    expect(elsewhere(validated.args), name).not.toContain(SENTINEL.toLowerCase());
  });

  it("sub_account_stats refuses a padded id (an exact one validates, above)", () => {
    const v = AI_SUITE_CAPABILITIES.find((c) => c.name === "sub_account_stats")!.validate({ subAccountId: " sa1", subAccountName: "Acme" });
    expect(v).toMatchObject({ ok: false, error: expect.stringContaining("no surrounding spaces") });
  });
});

describe("a sub-account tool's validator never sees an agency key's subAccountId", () => {
  const agencyKey: AgencyApiAuthContext = { ...subKey, level: "agency", subAccountId: null, keyLevel: "agency", keyId: "ak1" };

  beforeEach(() => {
    mem.seed("agencies/ag1", { agentApiEnabled: true });
    mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
  });

  it("every agent-callable tool: dispatch pops the target before validate", async () => {
    const tools = AI_SUITE_CAPABILITIES.filter(agentCallable);
    expect(tools.length).toBeGreaterThan(50);
    for (const cap of tools) {
      // Stops the call at validate: nothing past it runs.
      const spy = vi.spyOn(cap, "validate").mockReturnValue({ ok: false, error: "stop" });
      expect(await dispatchAgentTool(agencyKey, cap.name, { subAccountId: "sa1" }), cap.name).toMatchObject({ ok: false, code: "invalid_args" });
      expect(spy, cap.name).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(spy.mock.calls[0]![0] ?? {}), cap.name).not.toContain("sa1");
      spy.mockRestore();
    }
  });
});
