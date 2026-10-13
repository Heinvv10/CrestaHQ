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

/** Firebase Auth accounts by email, for `getAdminAuth().getUserByEmail` (cleared per test). */
export const authUsers = new Map<string, { uid: string; email: string; emailVerified: boolean; disabled?: boolean; customClaims?: Record<string, unknown> }>();
const fakeAuth = {
  getUserByEmail: async (email: string) => {
    const user = authUsers.get(email);
    if (!user) throw Object.assign(new Error("no user record"), { code: "auth/user-not-found" });
    return user;
  },
};
export const adminMock = () => ({ getAdminDb: () => mem.db, getAdminAuth: () => fakeAuth });
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
  level: "sub-account",
  keyLevel: "sub-account",
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
// An outbound preview must pin what it sends; the fixture pins its body.
const previewBody: NonNullable<AiSuiteCapability["preview"]> = async (_ctx, args) => ({
  rows: [{ label: "Body", value: String(args.body) }],
  pinned: { body: String(args.body) },
});
const sent = () => ({ resultText: "sent", ref: { kind: "message", id: "m1" } });
export const execute = vi.fn(async (..._a: Parameters<AiSuiteCapability["execute"]>) => sent());
// The fixture's message is tenant-wide unless a test targets a record.
const tenantWide: NonNullable<AiSuiteCapability["approvalTarget"]> = async () => ({
  contactId: null,
  territoryId: null,
  scoped: false,
});
/** approvalTarget for a fixture that targets a contact by `args[argName]`. */
export const contactTarget =
  (argName: string): NonNullable<AiSuiteCapability["approvalTarget"]> =>
  async (_ctx, args) => {
    const id = String(args[argName]);
    return { contactId: id, territoryId: (mem.read(`contacts/${id}`)?.territoryId as string) ?? null, scoped: true };
  };
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
  approvalTarget: tenantWide,
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
export async function decide(
  id: string,
  decision: string,
  subAccountId = "sa1",
  rev = mem.read(`agentProposals/${id}`)?.rev,
  extra: Record<string, unknown> = {}
) {
  const { POST } = await decideRoute();
  return POST(
    new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ decision, rev, ...extra }) }),
    { params: Promise.resolve({ id: subAccountId, proposalId: id }) }
  );
}
export async function revoke(keyId = "key1") {
  const { DELETE } = await import("@/app/api/sub-accounts/[id]/api-keys/[keyId]/route");
  return DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
    params: Promise.resolve({ id: "sa1", keyId }),
  });
}
/** Claim as another approver who sees every territory (an admin). */
export async function claim(id: string, uid = "u_other") {
  return (await lib()).claimProposal(id, { uid, email: "" }, row(id).rev as string, { enforce: false, ids: null });
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

/**
 * Hang the next execute until `finish` / `fail` is called. `started` resolves
 * the moment execute is actually entered, so a test can await that signal
 * instead of polling a wall-clock window.
 */
export function hangNextExecute(): { finish: () => void; fail: (err: Error) => void; started: Promise<void> } {
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const ctl = { finish: () => {}, fail: (_e: Error) => {}, started };
  execute.mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        ctl.finish = () => resolve(sent());
        ctl.fail = reject;
        markStarted();
      })
  );
  return ctl;
}

/** Approve with a hanging execute, then let the sweep flip the claim to unsettled. */
export async function approveHangingThenUnsettle(id: string) {
  const ctl = hangNextExecute();
  const { started } = ctl;
  const approving = decide(id, "approve");
  // Wait for execute to be entered; if the approve settles first, execute never ran.
  const outcome = await Promise.race([started.then(() => "started" as const), approving.then(() => "settled" as const)]);
  if (outcome === "settled") throw new Error("approve settled without entering execute");
  const { STALE_CLAIM_MS } = await lib();
  await sweep(later(STALE_CLAIM_MS + 60_000));
  expect(row(id).status).toBe("unsettled");
  return { ...ctl, approving };
}

/** Rejects with a clear error if `work` has not settled within `ms`. */
export function settleWithin<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * `await setupAgentProposalTests()` at the top level of the test file. The
 * replay module pulls in the whole capability registry; its cold import ran
 * past the 30 s hookTimeout on the loaded CI box when it sat in beforeEach,
 * and the timed-out hook's import then raced the next hook's (the mocker
 * cannot tell two in-flight imports apart), handing it the unmocked module.
 * Awaited at module load it has no vitest timeout, so it gets its own: a
 * hung import fails the file in 60 s instead of stalling the run.
 */
export async function setupAgentProposalTests() {
  // One at a time: concurrent imports of a mocked module defeat vi.mock.
  const modules = settleWithin(
    (async () => {
      const { replayHeldEnrolment } = await import("@/lib/server/agent-enrolment-replay");
      const { AI_SUITE_CAPABILITIES } = await import("@/lib/ai-suite/capabilities");
      return { replayHeldEnrolment, AI_SUITE_CAPABILITIES };
    })(),
    60_000,
    "agent-proposals harness: importing the replay module and capability registry",
  );

  beforeEach(async () => {
    const { replayHeldEnrolment, AI_SUITE_CAPABILITIES } = await modules;
    mem.clear();
    authUsers.clear();
    const gates = { agentApiEnabledByAgency: true, apiAccessEnabledByAgency: true };
    mem.seed("subAccounts/sa1", { agencyId: "ag1", ...gates });
    mem.seed("subAccounts/sa2", { agencyId: "ag1", ...gates });
    for (const keyId of ["key1", "key2"]) {
      mem.seed(`subAccounts/sa1/apiKeys/${keyId}`, { subAccountId: "sa1", agencyId: "ag1", name: "Agent key", mode: "live", prefix: "abcd1234", scopes: ["agent"], revokedAt: null });
    }
    caller.role = "admin";
    execute.mockReset();
    execute.mockImplementation(async () => sent());
    vi.mocked(replayHeldEnrolment).mockClear();
    Object.assign(outbound, {
      requiredRole: "subAccountMember",
      approval: "outbound",
      validate: validateAny,
      preview: previewBody,
      approvalTarget: tenantWide,
    });
    AI_SUITE_CAPABILITIES.push(outbound);
  });

  afterEach(async () => {
    const { AI_SUITE_CAPABILITIES } = await modules;
    // A beforeEach that failed before its push must not splice(-1) a real capability.
    const at = AI_SUITE_CAPABILITIES.indexOf(outbound);
    if (at !== -1) AI_SUITE_CAPABILITIES.splice(at, 1);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  await modules;
}
