import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `deleteSubAccountForAgency`'s emptiness guard over the in-memory Firestore.
 * A sub-account that still owns a top-level `workflows` doc is refused with
 * the "workflows" label and nothing is deleted — the delete has no cascade,
 * so letting it through would orphan the workflow.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/gbp-sync-store")).adminMock());

import { mem } from "@/test/gbp-sync-store";
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
});
