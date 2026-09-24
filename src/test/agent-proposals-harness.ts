import { afterEach, beforeEach, expect, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { ApiAuthContext } from "@/lib/api/auth";
import type { AiSuiteCapability } from "@/lib/ai-suite/capabilities";

/**
 * Shared harness for the agent approval-queue tests, split across the
 * `agent-proposals/[proposalId]/route.*.test.ts` files to stay under the
 * 300-line cap. Proposals come from the real dispatchAgentTool, decisions go
 * through the real decide route, sweeps are the real ones, all over one
 * in-memory Firestore. `__test_outbound` is a test-only capability (approval
 * "outbound") whose execute is a spy; it is never in the shipped registry.
 *
 * Each test file declares the mocks (vi.mock is hoisted per file):
 *   vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
 *   vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
 *   vi.mock("@/lib/server/agent-enrolment-replay", async (orig) => (await import("@/test/agent-proposals-harness")).replayMock(orig));
 * Vitest isolates module state per file, so each file gets its own store.
 */

export const mem = createMemoryFirestore();
export const caller = { uid: "u_admin", email: "admin@x.io", role: "admin" as string };

export const adminMock = () => ({ getAdminDb: () => mem.db });
export async function tenancyMock() {
  const { NextResponse } = await import("next/server");
  const member = async (_req: Request, subAccountId: string) =>
    subAccountId === "sa1" || subAccountId === "sa2"
      ? { uid: caller.uid, email: caller.email, agencyId: "ag1", subAccountId, subAccountRole: caller.role }
      : NextResponse.json({ error: "Not a member" }, { status: 403 });
  return { requireSubAccountMember: member, requireSubAccountAdmin: member };
}
export async function replayMock(importOriginal: () => Promise<unknown>) {
  const real = (await importOriginal()) as typeof import("@/lib/server/agent-enrolment-replay");
  return { replayHeldEnrolment: vi.fn(real.replayHeldEnrolment) };
}

export const auth: ApiAuthContext = {
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

const validateAny: AiSuiteCapability["validate"] = (raw) => ({
  ok: true,
  args: (raw ?? {}) as Record<string, unknown>,
});
const previewBody: NonNullable<AiSuiteCapability["preview"]> = async (_ctx, args) => [
  { label: "Body", value: String(args.body) },
];
const sent = () => ({ resultText: "sent", ref: { kind: "message", id: "m1" } });
export const execute = vi.fn(async (..._a: Parameters<AiSuiteCapability["execute"]>) => sent());
export const outbound: AiSuiteCapability = {
  name: "__test_outbound",
  level: "sub-account",
  requiredRole: "subAccountMember",
  approval: "outbound",
  menuLabel: "fixture",
  description: "fixture",
  parameters: { type: "object", properties: {} },
  validate: validateAny,
  summarize: (args) => `Send “${args.body}”`,
  preview: previewBody,
  execute,
};

const lib = () => import("@/lib/server/agent-proposals");
const decideRoute = () => import("@/app/api/sub-accounts/[id]/agent-proposals/[proposalId]/route");

export async function propose(args: Record<string, unknown> = { body: "hi" }, key = auth) {
  const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
  return dispatchAgentTool(key, "__test_outbound", args);
}
export async function proposeId(args?: Record<string, unknown>, key = auth): Promise<string> {
  const r = await propose(args, key);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
export const row = (id: string) => mem.read(`agentProposals/${id}`)!;
export const history = (id: string) => mem.list(`agentProposals/${id}/history`);
export const later = (ms: number) => new Date(Date.now() + ms);

/** Decide as an approver whose page shows generation `rev` (default: the current one). */
export async function decide(id: string, decision: string, subAccountId = "sa1", rev = mem.read(`agentProposals/${id}`)?.rev) {
  const { POST } = await decideRoute();
  return POST(
    new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ decision, rev }) }),
    { params: Promise.resolve({ id: subAccountId, proposalId: id }) }
  );
}
export async function revoke(keyId = "key1") {
  const { DELETE } = await import("@/app/api/sub-accounts/[id]/api-keys/[keyId]/route");
  return DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
    params: Promise.resolve({ id: "sa1", keyId }),
  });
}
export async function claim(id: string, uid = "u_other") {
  return (await lib()).claimProposal(id, { uid, email: "" }, row(id).rev as string);
}
export async function sweep(now: Date) {
  return (await import("@/lib/server/agent-proposals-sweeps")).sweepAgentProposals(now);
}
/** Make the row's claim old enough for mark_sent / mark_not_sent. */
export async function ageClaim(id: string) {
  const { MARK_MIN_AGE_MS } = await lib();
  mem.seed(`agentProposals/${id}`, { ...row(id), claimedAt: new Date(Date.now() - MARK_MIN_AGE_MS - 1000) });
}

/** Run `during` between a caller's read and its first transaction. */
export function beforeNextTransaction(during: () => Promise<unknown>) {
  const original = mem.db.runTransaction.bind(mem.db);
  vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn) => {
    await during();
    return original(fn as Parameters<typeof original>[0]);
  });
}

/** Hang the next execute until the returned function is called (or failed). */
export function hangNextExecute(): { finish: () => void; fail: (err: Error) => void } {
  const ctl = { finish: () => {}, fail: (_e: Error) => {} };
  execute.mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        ctl.finish = () => resolve(sent());
        ctl.fail = reject;
      })
  );
  return ctl;
}

/** Approve with a hanging execute, then let the sweep flip the claim to unsettled. */
export async function approveHangingThenUnsettle(id: string) {
  const ctl = hangNextExecute();
  const calls = execute.mock.calls.length;
  const approving = decide(id, "approve");
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(calls + 1));
  const { STALE_CLAIM_MS } = await lib();
  await sweep(later(STALE_CLAIM_MS + 60_000));
  expect(row(id).status).toBe("unsettled");
  return { ...ctl, approving };
}

export function setupAgentProposalTests() {
  beforeEach(async () => {
    mem.clear();
    const gates = { agentApiEnabledByAgency: true, apiAccessEnabledByAgency: true };
    mem.seed("subAccounts/sa1", { agencyId: "ag1", ...gates });
    mem.seed("subAccounts/sa2", { agencyId: "ag1", ...gates });
    for (const keyId of ["key1", "key2"]) {
      mem.seed(`subAccounts/sa1/apiKeys/${keyId}`, { subAccountId: "sa1", agencyId: "ag1", name: "Agent key", mode: "live", prefix: "abcd1234", scopes: ["agent"], revokedAt: null });
    }
    caller.role = "admin";
    execute.mockReset();
    execute.mockImplementation(async () => sent());
    const { replayHeldEnrolment } = await import("@/lib/server/agent-enrolment-replay");
    vi.mocked(replayHeldEnrolment).mockClear();
    Object.assign(outbound, {
      requiredRole: "subAccountMember",
      approval: "outbound",
      validate: validateAny,
      preview: previewBody,
    });
    delete outbound.approvalContactId;
    const { AI_SUITE_CAPABILITIES } = await import("@/lib/ai-suite/capabilities");
    AI_SUITE_CAPABILITIES.push(outbound);
  });

  afterEach(async () => {
    const { AI_SUITE_CAPABILITIES } = await import("@/lib/ai-suite/capabilities");
    AI_SUITE_CAPABILITIES.splice(AI_SUITE_CAPABILITIES.indexOf(outbound), 1);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
}
