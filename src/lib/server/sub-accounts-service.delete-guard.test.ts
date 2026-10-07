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
import { deleteDecidedProposals } from "@/lib/agency/sub-account-delete-guard";
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
    ["recurringInvoices", "recurring invoices"],
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
      expect((err as SubAccountNotEmptyError).blockers).toEqual(["agent approvals waiting or in progress"]);
      expect(mem.read(`subAccounts/${SA}`)).toBeDefined();
      expect(mem.read("agentProposals/p_1")).toBeDefined();
    }
  );

  it("an agency-level pending row targeting the sub-account blocks the delete", async () => {
    await row("p_ag", { subAccountId: null, targetSubAccountId: SA, keyLevel: "agency", status: "pending" });

    const err = await deleteSubAccountForAgency({ agencyId: AG, subAccountId: SA }).catch((e) => e);

    expect((err as SubAccountNotEmptyError).blockers).toEqual(["agent approvals waiting or in progress"]);
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

  it("decided rows' history generations go with them", async () => {
    await row("p_done", { subAccountId: SA, status: "executed" });
    await mem.db.doc("agentProposals/p_done/history/h1").set({ agencyId: AG, subAccountId: SA, status: "superseded" });

    await deleteSubAccountForAgency({ agencyId: AG, subAccountId: SA });

    expect(mem.read("agentProposals/p_done")).toBeUndefined();
    expect(mem.read("agentProposals/p_done/history/h1")).toBeUndefined();
  });

  it("a row an agent re-proposes after the query found it decided is kept, with its history", async () => {
    await row("p_flip", { subAccountId: SA, status: "rejected" });
    // The row id is reused for a re-proposal: between the clean-up's query and
    // its delete, the row turns pending again (its old generation into history).
    const racing = {
      ...storeDb,
      collection: (name: string) => {
        const c = storeDb.collection(name);
        return {
          where: (f: string, op: "==", v: unknown) => ({
            get: async () => {
              const r = await c.where(f, op, v).get();
              await mem.db.doc("agentProposals/p_flip/history/g1").set({ agencyId: AG, subAccountId: SA, status: "rejected" });
              await mem.db.doc("agentProposals/p_flip").set({ agencyId: AG, subAccountId: SA, status: "pending" });
              return r;
            },
          }),
        };
      },
    };

    const reopened = await deleteDecidedProposals(racing as unknown as FirebaseFirestore.Firestore, SA);

    expect(reopened).toBe(1);
    expect(mem.read("agentProposals/p_flip")?.status).toBe("pending");
    expect(mem.read("agentProposals/p_flip/history/g1")).toBeDefined();
  });

  it("a row that turns open again refuses the delete before anything else is removed", async () => {
    await row("p_flip", { subAccountId: SA, status: "rejected" });
    await mem.db.doc(`userMemberships/uid_owner/subAccounts/${SA}`).set({ role: "admin" });
    await mem.db.doc("message_templates/t_1").set({ agencyId: AG, subAccountId: SA });
    const collection = storeDb.collection.bind(storeDb);
    const spy = vi.spyOn(storeDb, "collection").mockImplementation(((name: string) => {
      const c = collection(name);
      if (name !== "agentProposals") return c;
      return {
        where: (f: string, op: "==", v: unknown) => {
          const q = c.where(f, op, v);
          return {
            ...q,
            where: q.where.bind(q),
            limit: q.limit.bind(q),
            get: async () => {
              const r = await q.get();
              // Only the clean-up's unfiltered query flips the row, after the guard has passed.
              if (f === "subAccountId" && r.docs.some((d) => d.id === "p_flip")) {
                await mem.db.doc("agentProposals/p_flip").set({ agencyId: AG, subAccountId: SA, status: "pending" });
              }
              return r;
            },
          };
        },
      };
    }) as typeof storeDb.collection);

    const err = await deleteSubAccountForAgency({ agencyId: AG, subAccountId: SA }).catch((e) => e);

    spy.mockRestore();
    expect((err as SubAccountNotEmptyError).blockers).toEqual(["agent approvals waiting or in progress"]);
    expect(mem.read(`subAccounts/${SA}`)).toBeDefined();
    expect(mem.read(`userMemberships/uid_owner/subAccounts/${SA}`)).toBeDefined();
    expect(mem.read("message_templates/t_1")).toBeDefined();
    expect(mem.read("agentProposals/p_flip")?.status).toBe("pending");
  });

  it("never reads or writes subAccounts/null", async () => {
    await row("p_ag_done", { subAccountId: null, targetSubAccountId: SA, keyLevel: "agency", status: "executed" });
    const paths: string[] = [];
    // getAdminDb() returns storeDb; spy on THAT (mem.db's doc is a copy taken at load).
    const doc = storeDb.doc.bind(storeDb);
    const spy = vi.spyOn(storeDb, "doc").mockImplementation((p: string) => (paths.push(p), doc(p)));

    await deleteSubAccountForAgency({ agencyId: AG, subAccountId: SA });

    spy.mockRestore();
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => p.startsWith("subAccounts/null"))).toEqual([]);
  });
});
