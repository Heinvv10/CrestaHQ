import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, history, mem, proposeId, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { proposeScoped, seedAgency } from "@/test/agency-approvals-harness";

/**
 * Frozen-row rollover in createProposal (A5, Hein 2026-10-05). The row id is
 * the action's, not the key's, so an agency key's pending row whose key can
 * no longer be approved (revoked, the agency switch off, the minter no
 * longer an active owner) would block a different key's identical proposal
 * until it expired. When a DIFFERENT key re-proposes the same action, that
 * frozen row moves to `history` as `superseded` and the new key gets a fresh
 * pending generation. A live key's row is never superseded, and the same key
 * re-proposing gets today's answer (the same row back).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agency-approvals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

await setupAgentProposalTests();
beforeEach(seedAgency);

/** The same action from the agency key and from sa1's own key: one id. */
const viaAgencyKey = () => proposeScoped("sa1", "hi");
const viaSubKey = () => proposeId({ body: "hi" }, auth);

const freezes: Array<[string, () => void]> = [
  ["its key revoked", () => mem.seed("agencies/ag1/apiKeys/ak1", { ...mem.read("agencies/ag1/apiKeys/ak1")!, revokedAt: new Date() })],
  ["the agency's switch off", () => mem.seed("agencies/ag1", { agentApiEnabled: false })],
  ["its minter demoted", () => mem.seed("agencies/ag1/agencyMembers/owner1", { role: "member", status: "active" })],
  ["its minter deactivated", () => mem.seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "inactive" })],
];

describe("a frozen agency-key row, re-proposed by a different key", () => {
  it.each(freezes)("%s → superseded into history, a fresh pending generation for the new key", async (_label, freeze) => {
    const id = await viaAgencyKey();
    const old = row(id);
    expect(old).toMatchObject({ keyLevel: "agency", keyId: "ak1", status: "pending" });
    freeze();
    expect(await viaSubKey()).toBe(id);
    expect(row(id)).toMatchObject({ status: "pending", keyLevel: "sub-account", keyId: "key1" });
    expect(row(id).rev).not.toBe(old.rev);
    expect(history(id)).toEqual([expect.objectContaining({ status: "superseded", keyId: "ak1", rev: old.rev })]);
  });
});

describe("never superseded", () => {
  it("a live key's row: a different key gets the same row back, nothing moves to history", async () => {
    const id = await viaAgencyKey();
    const before = row(id);
    expect(await viaSubKey()).toBe(id);
    expect(row(id)).toEqual(before);
    expect(history(id)).toEqual([]);
  });

  it("the same key re-proposing its own frozen row: today's answer, the same row back", async () => {
    const id = await viaAgencyKey();
    const before = row(id);
    mem.seed("agencies/ag1", { agentApiEnabled: false });
    const { createProposal } = await import("@/lib/server/agent-proposals");
    const again = await createProposal({
      agencyId: "ag1", subAccountId: "sa1", keyId: "ak1", keyPrefix: "agcy1234", keyLevel: "agency",
      capability: before.capability as string, approval: "outbound", args: before.args as Record<string, unknown>,
      summary: "s", preview: [], pinned: null, target: { contactId: null, territoryId: null, scoped: false },
    });
    expect(again).toMatchObject({ ok: true, id, rev: before.rev, status: "pending" });
    expect(row(id)).toEqual(before);
    expect(history(id)).toEqual([]);
  });

  it("a revoked v1 key's row is superseded by the agency key the same way", async () => {
    const id = await viaSubKey();
    mem.seed("subAccounts/sa1/apiKeys/key1", { ...mem.read("subAccounts/sa1/apiKeys/key1")!, revokedAt: new Date() });
    expect(await viaAgencyKey()).toBe(id);
    expect(row(id)).toMatchObject({ status: "pending", keyLevel: "agency", keyId: "ak1" });
    expect(history(id)).toEqual([expect.objectContaining({ status: "superseded", keyId: "key1" })]);
  });
});
