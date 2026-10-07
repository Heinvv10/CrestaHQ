import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { parseArgs } from "./teardown-smoke-sub-account";
import {
  AG, SA, SB, hooked, mem, patchTarget, resetStore, run, snapshot, targetPaths,
} from "./teardown-smoke-sub-account.fixture";

/**
 * What lands, or is left, while a `--yes` run is under way: the mid-run
 * re-check, the "partial" outcome, and each branch of the final re-read.
 * R1–R6 / H1–H3 are the adversarial review's repros (round 1).
 */

beforeEach(resetStore);

const KEPT = /appeared mid-run; the sub-account is kept/;

describe("breaker repros", () => {
  it("R1 live billing subscription on the doc: must refuse", async () => {
    patchTarget({ billing: { status: "active", stripeSubscriptionId: "sub_live_1", planId: "plan_1", priceCents: 49900 } });
    const { result } = await run();
    expect(mem.read(`subAccounts/${SA}`)).toBeDefined();
    expect(result.outcome).toBe("refused");
  });

  it("R2 channel connection + private/ credential made mid-run: the sub-account is kept (partial)", async () => {
    let done = false;
    const db2 = hooked((p) => {
      if (!done && p.startsWith("workflows/")) {
        done = true;
        patchTarget({ twilioConfig: { accountSid: "AC1", phoneNumber: "+27100000000" } });
        mem.seed(`subAccounts/${SA}/private/twilioCredentials`, { authToken: "secret" });
      }
    });
    const { result, out } = await run({ using: db2 });
    expect(mem.read(`subAccounts/${SA}/private/twilioCredentials`)).toBeDefined();
    expect(mem.read(`subAccounts/${SA}`)).toBeDefined();
    expect(result.outcome).toBe("partial");
    expect(result.refusals.join("\n")).toMatch(/channel connection .*appeared mid-run; the sub-account is kept/);
    expect(result.refusals.join("\n")).toMatch(/private\/ holds twilioCredentials .*appeared mid-run/);
    expect(out).toMatch(/^PARTIAL: stopped mid-run, the sub-account is kept; already deleted: agentProposals \(decided\), workflows, forms, products, snippets, message_templates, invites$/m);
    expect(out).not.toMatch(/nothing deleted/);
  });

  it("R3 contact landing after the final recheck: exit 2, not 'deleted'", async () => {
    const db2 = hooked((p) => {
      if (p === `subAccounts/${SA}`) mem.seed("contacts/c_real", { agencyId: AG, subAccountId: SA, name: "Real Person" });
    });
    const { result } = await run({ using: db2 });
    expect(mem.read("contacts/c_real")).toBeDefined();
    expect(mem.read(`subAccounts/${SA}`)).toBeUndefined();
    expect(result.outcome).toBe("leftover");
    expect(result.leftovers).toEqual(["blocked: contacts"]);
  });

  it("R4 member added after memberships were deleted: leftover reports the dangling userMemberships", async () => {
    const db2 = hooked((p) => {
      if (p === `subAccounts/${SA}`) {
        mem.seed(`subAccounts/${SA}/subAccountMembers/uid_late`, { role: "collaborator" });
        mem.seed(`userMemberships/uid_late/subAccounts/${SA}`, { subAccountId: SA });
      }
    });
    const { result } = await run({ using: db2 });
    expect(mem.read(`userMemberships/uid_late/subAccounts/${SA}`)).toBeDefined();
    expect(result.outcome).toBe("leftover");
    expect(result.leftovers).toContain(`userMemberships/uid_late/subAccounts/${SA}`);
  });

  it("R5 createdAt an invalid Date (NaN ms): 72 h guard must refuse", async () => {
    patchTarget({ createdAt: new Date(Number.NaN) });
    const { result } = await run({ yes: false });
    expect(result.outcome).toBe("refused");
  });

  it("R6 provisioned Vapi voice line under aiAgent/voice: must refuse", async () => {
    mem.seed(`subAccounts/${SA}/aiAgent/voice`, { enabled: true, voice: { vapiAssistantId: "asst_1", vapiPhoneNumberId: "pn_1" } });
    const { result } = await run();
    expect(mem.read(`subAccounts/${SA}/aiAgent/voice`)).toBeDefined();
    expect(result.outcome).toBe("refused");
  });

  it("H1 sibling-shared invite email, shared member, sibling proposals, null/missing subAccountId rows untouched", async () => {
    mem.seed(`invites/inv_shared_${SB}`, { agencyId: AG, subAccountId: SB, email: "x@example.test", acceptedByUid: null, revokedAt: null });
    mem.seed(`userMemberships/uid_owner/subAccounts/${SB}`, { subAccountId: SB });
    mem.seed("agentProposals/p_agency", { agencyId: AG, subAccountId: null, status: "executed" });
    mem.seed("agentProposals/p_agency2", { agencyId: AG, subAccountId: null, targetSubAccountId: SB, status: "executed" });
    mem.seed("workflows/wf_nosub", { agencyId: AG, status: "active" });
    mem.seed("workflows/wf_prefix", { agencyId: AG, subAccountId: `${SA}2`, status: "active" });
    mem.seed(`workflows/${SA}`, { agencyId: AG, subAccountId: SB, status: "active" });
    mem.seed(`workflows/${SA}x/runs/r1`, { subAccountId: SB });
    const before = snapshot();
    const { result } = await run();
    expect(result.outcome).toBe("deleted");
    const after = snapshot();
    const gone = [...before.keys()].filter((p) => !after.has(p)).sort();
    expect(gone).toEqual(targetPaths(SA).sort());
  });

  it("H2 parseArgs never yields yes without the exact flag, nor an empty id", () => {
    expect(parseArgs(["--project", "p", "--sub-account", "sa", "--yes=false"]).yes).toBe(false);
    expect(parseArgs(["--project", "p", "--sub-account", "sa", "--YES"]).yes).toBe(false);
    expect(() => parseArgs(["--project", "p", "--sub-account", ""])).toThrow();
    expect(() => parseArgs(["--project", "p", "--sub-account", " sa"])).toThrow();
    expect(() => parseArgs(["--project", "", "--sub-account", "sa"])).toThrow();
  });

  it("H3 decided row re-opened mid-run stops before any content goes (partial: decided rows only)", async () => {
    const realTx = mem.db.runTransaction.bind(mem.db);
    let flipped = false;
    const db2 = {
      ...mem.db,
      runTransaction: async (fn: Parameters<typeof mem.db.runTransaction>[0]) => {
        if (!flipped) { flipped = true; mem.seed(`agentProposals/p_done_${SA}`, { agencyId: AG, subAccountId: SA, status: "pending" }); }
        return realTx(fn);
      },
    } as unknown as Firestore;
    const before = snapshot();
    const { result, out } = await run({ using: db2 });
    expect(result.outcome).toBe("partial");
    expect(mem.read(`subAccounts/${SA}`)).toBeDefined();
    expect(mem.read(`workflows/wf_${SA}`)).toEqual(before.get(`workflows/wf_${SA}`));
    expect(out).toMatch(/^PARTIAL: stopped mid-run, the sub-account is kept; already deleted: agentProposals \(decided\)$/m);
  });
});

describe("mid-run re-check", () => {
  it.each([
    ["a contact", () => mem.seed("contacts/c_late", { agencyId: AG, subAccountId: SA }), /^blocked: contacts \(appeared mid-run/],
    ["Client Billing", () => patchTarget({ billing: { status: "pending", planId: "plan_1" } }), /^billing: .*appeared mid-run/],
    ["a voice line", () => mem.seed(`subAccounts/${SA}/aiAgent/voice`, { voice: { vapiPhoneNumberId: "pn_1" } }), /^voice line: .*appeared mid-run/],
  ])("%s landing after the guards stops the run before the sub-account goes", async (_, land, reason) => {
    let landed = false;
    const { result } = await run({ using: hooked((p) => void (!landed && p.startsWith("workflows/") && ((landed = true), land()))) });

    expect(result.outcome).toBe("partial");
    expect(result.refusals.some((r) => reason.test(r) && KEPT.test(r))).toBe(true);
    expect(mem.read(`subAccounts/${SA}`)).toBeDefined();
    expect(mem.read(`userMemberships/uid_owner/subAccounts/${SA}`)).toBeDefined();
  });
});

describe("final re-read: each kind of doc left behind is exit 2", () => {
  const at = (target: string, then: () => void) => hooked(() => {}, (p) => void (p === target && then()));

  it("the sub-account doc itself", async () => {
    const keepDoc = {
      ...mem.db,
      recursiveDelete: async (ref: { path: string }) => {
        const doc = mem.read(ref.path);
        await mem.db.recursiveDelete(ref as Parameters<typeof mem.db.recursiveDelete>[0]);
        if (ref.path === `subAccounts/${SA}` && doc) mem.seed(ref.path, doc);
      },
    } as unknown as Firestore;
    const { result } = await run({ using: keepDoc });
    expect(result).toMatchObject({ outcome: "leftover", leftovers: [`subAccounts/${SA}`] });
  });

  it("an agent approval row", async () => {
    const { result } = await run({
      using: at(`subAccounts/${SA}`, () => mem.seed("agentProposals/p_late", { agencyId: AG, subAccountId: null, targetSubAccountId: SA, status: "rejected" })),
    });
    expect(result).toMatchObject({ outcome: "leftover", leftovers: ["agentProposals/p_late"] });
  });

  it("a subcollection under the deleted sub-account", async () => {
    const { result } = await run({ using: at(`subAccounts/${SA}`, () => mem.seed(`subAccounts/${SA}/pipelines/late`, { name: "x" })) });
    expect(result).toMatchObject({ outcome: "leftover", leftovers: [`subAccounts/${SA}/pipelines/…`] });
  });
});

describe("memberships and approval rows", () => {
  it("removes the creator's userMemberships entry even when the creator is not a member", async () => {
    patchTarget({ createdByUid: "uid_creator" });
    mem.seed(`userMemberships/uid_creator/subAccounts/${SA}`, { subAccountId: SA });
    const { result } = await run();
    expect(result.outcome).toBe("deleted");
    expect(mem.read(`userMemberships/uid_creator/subAccounts/${SA}`)).toBeUndefined();
  });

  it("never deletes an open approval row, even with findDeleteBlockers' open-row probes blinded", async () => {
    mem.seed("agentProposals/p_open", { agencyId: AG, subAccountId: SA, status: "pending" });
    // Every `… where status == x` probe answers empty; plain queries are untouched.
    const blind = {
      ...mem.db,
      collection: (name: string) => {
        const c = mem.db.collection(name);
        if (name !== "agentProposals") return c;
        return {
          ...c,
          where: (f: string, op: "==", v: unknown) => {
            const q = c.where(f, op, v);
            return { ...q, where: (f2: string, op2: "==", v2: unknown) => (f2 === "status" ? q.where("__never", "==", true) : q.where(f2, op2, v2)) };
          },
        };
      },
    } as unknown as Firestore;

    const { result } = await run({ using: blind });

    expect(result.plan.get("agentProposals (decided)")).not.toContain("agentProposals/p_open");
    expect(mem.read("agentProposals/p_open")).toBeDefined();
    expect(result).toMatchObject({ outcome: "leftover", leftovers: ["agentProposals/p_open"] });
  });
});
