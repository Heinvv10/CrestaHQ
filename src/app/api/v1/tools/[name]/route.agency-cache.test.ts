import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth as subKey, mem, setupDispatchTests } from "@/test/agent-dispatch-harness";
import type { AgencyApiAuthContext, WithApiAuthOptions } from "@/lib/api/auth";

/**
 * The tools route's idempotency hook for agency-level reads: a stored
 * list_sub_accounts reply would replay for 24h and outlive a gate switch
 * (precheck has no subAccountId to stop it). The route's real options are
 * captured from its withApiAuth call, so this pins the route file itself.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-dispatch-harness")).adminMock());
let opts: WithApiAuthOptions | undefined;
vi.mock("@/lib/api/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/auth")>()),
  withApiAuth: (handler: unknown, o: WithApiAuthOptions) => {
    opts = o;
    return handler;
  },
}));

await import("./route");
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { agentPrecheck } = await import("@/lib/api/agent-precheck");
const { idempotencyOwner, reserveIdempotencyKey } = await import("@/lib/api/idempotency");

setupDispatchTests();

const agencyKey: AgencyApiAuthContext = { ...subKey, level: "agency", subAccountId: null, keyLevel: "agency", keyId: "ak1" };
const ON = { apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true };

beforeEach(() => {
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "One", ...ON });
  mem.seed("subAccounts/sa4", { agencyId: "ag1", name: "Four", ...ON });
});

describe("agency-level reads never take part in idempotency", () => {
  it("the route's cacheIdempotently refuses them, before and after the handler", () => {
    for (const name of ["list_sub_accounts", "sub_account_stats"]) {
      expect(opts?.cacheIdempotently?.({ name }), name).toBe(false);
      expect(opts?.cacheIdempotently?.({ name }, { status: 200, body: {} }), name).toBe(false);
    }
  });

  it("so a list never replays after a sub-account becomes unreachable", async () => {
    const live = (await dispatchAgentTool(agencyKey, "list_sub_accounts", {})) as { resultText: string };
    expect(live.resultText).toContain("id: sa4.");
    const owner = idempotencyOwner(agencyKey);
    const first = await reserveIdempotencyKey(owner, "live", "ak1", "k1", "fp");
    if (first.kind !== "reserved") throw new Error(first.kind);
    // What withApiAuth does with the outcome:
    if (opts?.cacheIdempotently?.({ name: "list_sub_accounts" }, { status: 200, body: {} })) {
      await first.store({ status: 200, bodyJson: { result: live.resultText } });
    } else {
      await first.release();
    }
    mem.seed("subAccounts/sa4", { agencyId: "ag1", name: "Four", ...ON, agentApiEnabledByAgency: false });
    expect(await agentPrecheck(agencyKey, {})).toBeNull(); // no subAccountId: precheck cannot stop a replay
    const again = await reserveIdempotencyKey(owner, "live", "ak1", "k1", "fp");
    expect(again.kind).not.toBe("replay");
    if (again.kind === "reserved") await again.release();
  });
});
