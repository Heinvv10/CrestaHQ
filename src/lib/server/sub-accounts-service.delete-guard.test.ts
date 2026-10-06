import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `deleteSubAccountForAgency`'s emptiness guard over the in-memory Firestore.
 * A sub-account that still owns a top-level doc in a usage collection, or an
 * agent approval still waiting, is refused with its label and nothing is
 * deleted — the delete has no cascade, so letting it through would orphan it.
 * Decided approval rows are history and go with the sub-account.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/gbp-sync-store")).adminMock());

import { mem, storeDb } from "@/test/gbp-sync-store";
import { deleteDecidedProposals } from "./sub-account-delete-guard";
import {
  deleteSubAccountForAgency,
  SubAccountNotEmptyError,
} from "./sub-accounts-service";

const AG = "ag_1";
const SA = "sa_1";

beforeEach(async () => {
  mem.clear();
  await mem.db.doc(`subAccounts/${SA}`).set({ agencyId: AG, name: "Fixture" });
  await mem.db.doc(`subAccounts/${SA}/subAccountMembers/uid_owner`).set({ role: "admin" });
});

describe("deleteSubAccountForAgency emptiness guard", () => {
  it("refuses a sub-account that still has a workflow, naming it, and deletes nothing", async () => {
    await mem.db.doc("workflows/wf_1").set({ agencyId: AG, subAccountId: SA, status: "draft" });

    const err = await deleteSubAccountForAgency({ agencyId: AG, subAccountId: SA }).catch((e) => e);

    expect(err).toBeInstanceOf(SubAccountNotEmptyError);
    expect((err as SubAccountNotEmptyError).blockers).toEqual(["workflows"]);
    expect(mem.read(`subAccounts/${SA}`)).toBeDefined();
    expect(mem.read(`subAccounts/${SA}/subAccountMembers/uid_owner`)).toBeDefined();
    expect(mem.read("workflows/wf_1")).toBeDefined();
  });

  it("a workflow on another sub-account does not block this one", async () => {
    await mem.db.doc("workflows/wf_other").set({ agencyId: AG, subAccountId: "sa_other", status: "draft" });

    await deleteSubAccountForAgency({ agencyId: AG, subAccountId: SA });

    expect(mem.read(`subAccounts/${SA}`)).toBeUndefined();
    expect(mem.read("workflows/wf_other")).toBeDefined();
  });

  it("deletes a sub-account with no workflows as before", async () => {
    await deleteSubAccountForAgency({ agencyId: AG, subAccountId: SA });

    expect(mem.read(`subAccounts/${SA}`)).toBeUndefined();
    expect(mem.read(`subAccounts/${SA}/subAccountMembers/uid_owner`)).toBeUndefined();
  });

  it.each([
    ["companies", "companies"],
    ["snippets", "saved replies"],
    ["trackedLinks", "tracked links"],
    ["paymentLinks", "payment links"],
    ["prospectLists", "prospect lists"],
    ["prospectReports", "prospect reports"],
  ])("a %s doc blocks the delete as %s, and nothing is deleted", async (collection, label) => {
    await mem.db.doc(`${collection}/x_1`).set({ agencyId: AG, subAccountId: SA });

    const err = await deleteSubAccountForAgency({ agencyId: AG, subAccountId: SA }).catch((e) => e);

    expect(err).toBeInstanceOf(SubAccountNotEmptyError);
    expect((err as SubAccountNotEmptyError).blockers).toEqual([label]);
    expect(mem.read(`subAccounts/${SA}`)).toBeDefined();
    expect(mem.read(`${collection}/x_1`)).toBeDefined();
  });
});

describe("deleteSubAccountForAgency and agent approval rows", () => {
  const row = (id: string, data: Record<string, unknown>) =>
    mem.db.doc(`agentProposals/${id}`).set({ agencyId: AG, ...data });

  it.each(["pending", "executing", "unsettled"])(
    "a %s row on the sub-account blocks the delete; nothing is deleted",
    async (status) => {
      await row("p_1", { subAccountId: SA, status });

      const err = await deleteSubAccountForAgency({ agencyId: AG, subAccountId: SA }).catch((e) => e);

      expect(err).toBeInstanceOf(SubAccountNotEmptyError);
      expect((err as SubAccountNotEmptyError).blockers).toEqual(["agent approvals waiting"]);
      expect(mem.read(`subAccounts/${SA}`)).toBeDefined();
      expect(mem.read("agentProposals/p_1")).toBeDefined();
    }
  );

  it("an agency-level pending row targeting the sub-account blocks the delete", async () => {
    await row("p_ag", { subAccountId: null, targetSubAccountId: SA, keyLevel: "agency", status: "pending" });

    const err = await deleteSubAccountForAgency({ agencyId: AG, subAccountId: SA }).catch((e) => e);

    expect((err as SubAccountNotEmptyError).blockers).toEqual(["agent approvals waiting"]);
    expect(mem.read(`subAccounts/${SA}`)).toBeDefined();
  });

  it("decided rows go with the sub-account, both keyings; other sub-accounts' rows stay", async () => {
    await row("p_done", { subAccountId: SA, status: "executed" });
    await row("p_rej", { subAccountId: SA, status: "rejected" });
    await row("p_ag_done", { subAccountId: null, targetSubAccountId: SA, keyLevel: "agency", status: "failed" });
    await row("p_exp", { subAccountId: SA, status: "expired" });
    await row("p_other", { subAccountId: "sa_other", status: "executed" });
    await row("p_other_pending", { subAccountId: null, targetSubAccountId: "sa_other", status: "pending" });

    await deleteSubAccountForAgency({ agencyId: AG, subAccountId: SA });

    expect(mem.read(`subAccounts/${SA}`)).toBeUndefined();
    for (const id of ["p_done", "p_rej", "p_ag_done", "p_exp"]) expect(mem.read(`agentProposals/${id}`)).toBeUndefined();
    expect(mem.read("agentProposals/p_other")).toBeDefined();
    expect(mem.read("agentProposals/p_other_pending")).toBeDefined();
  });

  it("the row clean-up never deletes an open row, even one that appeared after the guard", async () => {
    await row("p_done", { subAccountId: SA, status: "executed" });
    await row("p_late", { subAccountId: SA, status: "pending" });
    await row("p_late_ag", { subAccountId: null, targetSubAccountId: SA, status: "unsettled" });

    await deleteDecidedProposals(storeDb as unknown as FirebaseFirestore.Firestore, SA);

    expect(mem.read("agentProposals/p_done")).toBeUndefined();
    expect(mem.read("agentProposals/p_late")).toBeDefined();
    expect(mem.read("agentProposals/p_late_ag")).toBeDefined();
  });

  it("never reads or writes subAccounts/null", async () => {
    await row("p_ag_done", { subAccountId: null, targetSubAccountId: SA, keyLevel: "agency", status: "executed" });
    const paths: string[] = [];
    const doc = mem.db.doc.bind(mem.db);
    const spy = vi.spyOn(mem.db, "doc").mockImplementation((p: string) => (paths.push(p), doc(p)));

    await deleteSubAccountForAgency({ agencyId: AG, subAccountId: SA });

    spy.mockRestore();
    expect(paths.filter((p) => p.startsWith("subAccounts/null"))).toEqual([]);
  });
});
