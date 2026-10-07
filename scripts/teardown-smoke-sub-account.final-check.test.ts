import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { exitCodeFor } from "./teardown-smoke-sub-account";
import { projectRefusal } from "./teardown-smoke-sub-account-guards";
import { AG, PROJECT, SA, hooked, mem, patchTarget, resetStore, run } from "./teardown-smoke-sub-account.fixture";

/**
 * The last check before the sub-account goes (one transaction with the root
 * delete), the final re-read's open charges, and the adversarial review's
 * round-2 repros (N1, N2) and held cases.
 */

beforeEach(resetStore);

type Tx = Parameters<Parameters<typeof mem.db.runTransaction>[0]>[0];
type RD = Parameters<typeof mem.db.recursiveDelete>[0];

/**
 * The store, where `land` runs once in the first transaction after the
 * content deletes (the final check's): before its first read, or after it.
 */
function atFinalTransaction(land: () => void, when: "before-read" | "after-read") {
  let armed = false;
  let landed = false;
  return {
    ...mem.db,
    recursiveDelete: async (ref: { path: string }) => {
      await mem.db.recursiveDelete(ref as RD);
      if (ref.path.startsWith("invites/")) armed = true;
    },
    runTransaction: <T>(fn: (tx: Tx) => Promise<T>) =>
      mem.db.runTransaction((tx) => {
        const get: Tx["get"] = async (target) => {
          const go = armed && !landed;
          if (go && when === "before-read") {
            landed = true;
            land();
          }
          const r = await tx.get(target);
          if (go && when === "after-read") {
            landed = true;
            land();
          }
          return r;
        };
        return fn({ ...tx, get });
      }),
  } as unknown as Firestore;
}

/** The store, where `land` runs once right after the final check reads `aiAgent/` (through the transaction or not). */
function afterFinalAiAgentRead(land: () => void) {
  let armed = false;
  let landed = false;
  return {
    ...mem.db,
    recursiveDelete: async (ref: { path: string }) => {
      await mem.db.recursiveDelete(ref as RD);
      if (ref.path.startsWith("invites/")) armed = true;
    },
    doc: (path: string) => {
      const ref = mem.db.doc(path);
      if (path !== `subAccounts/${SA}`) return ref;
      const collection = (name: string) => {
        const c = ref.collection(name);
        if (name !== "aiAgent") return c;
        return { ...c, get: async () => ((r) => (armed && !landed && ((landed = true), land()), r))(await c.get()) };
      };
      return { ...ref, collection };
    },
  } as unknown as Firestore;
}

const billingAndTwilio = () => {
  patchTarget({ billing: { status: "active", stripeSubscriptionId: "sub_live_2" }, twilioConfig: { accountSid: "AC1" } });
  mem.seed(`subAccounts/${SA}/private/twilioCredentials`, { authToken: "secret" });
};

describe("the final check and the root delete are one transaction", () => {
  it.each(["before-read", "after-read"] as const)(
    "N1: billing + Twilio + a credential landing at the transaction (%s) → partial, all kept",
    async (when) => {
      const { result } = await run({ using: atFinalTransaction(billingAndTwilio, when) });

      expect(result.outcome).toBe("partial");
      expect(result.refusals.join("\n")).toMatch(/^billing: .*appeared mid-run/m);
      expect(result.refusals.join("\n")).toMatch(/^channel connection .*appeared mid-run/m);
      expect(result.refusals.join("\n")).toMatch(/^private\/ holds twilioCredentials .*appeared mid-run/m);
      expect(mem.read(`subAccounts/${SA}`)?.billing).toBeDefined();
      expect(mem.read(`subAccounts/${SA}/private/twilioCredentials`)).toBeDefined();
      expect(mem.read(`userMemberships/uid_owner/subAccounts/${SA}`)).toBeDefined();
    }
  );

  it("a Vapi id written to an aiAgent doc the transaction already read makes it retry and refuse", async () => {
    const vapi = { systemPrompt: "", voice: { vapiAssistantId: "asst_late" } };
    const { result } = await run({ using: afterFinalAiAgentRead(() => mem.seed(`subAccounts/${SA}/aiAgent/profile`, vapi)) });

    expect(result.outcome).toBe("partial");
    expect(result.refusals.join("\n")).toMatch(/^voice line: aiAgent\/profile .*appeared mid-run/m);
    expect(mem.read(`subAccounts/${SA}/aiAgent/profile`)).toEqual(vapi);
  });

  it.each([
    ["a workflow (a usage collection)", "workflows/wf_late", /^workflows: wf_late written after its delete/],
    ["a message template (not a usage collection)", "message_templates/t_late", /^message_templates: t_late written after its delete/],
  ])("%s landing after its collection was emptied → partial, the sub-account kept", async (_, path, reason) => {
    let landed = false;
    const { result } = await run({
      using: hooked(() => {}, (p) => void (!landed && p.startsWith("invites/") && ((landed = true), mem.seed(path, { agencyId: AG, subAccountId: SA })))),
    });

    expect(result.outcome).toBe("partial");
    expect(result.refusals.some((r) => reason.test(r))).toBe(true);
    expect(mem.read(`subAccounts/${SA}`)).toBeDefined();
  });
});

describe("final re-read", () => {
  it("N2 an open billingCharges row landing after the re-check is exit 2", async () => {
    const { result } = await run({
      using: hooked((p) => void (p === `subAccounts/${SA}` && mem.seed("billingCharges/ch_late", { agencyId: AG, subAccountId: SA, status: "pending", amountCents: 100000 }))),
    });
    expect(mem.read("billingCharges/ch_late")).toBeDefined();
    expect(result).toMatchObject({ outcome: "leftover", leftovers: ["billingCharges: ch_late not paid or canceled"] });
  });

  it("a settled charge landing then is not a leftover", async () => {
    const { result } = await run({
      using: hooked((p) => void (p === `subAccounts/${SA}` && mem.seed("billingCharges/ch_paid", { subAccountId: SA, status: "paid" }))),
    });
    expect(result.outcome).toBe("deleted");
  });
});

describe("exit codes", () => {
  it("refused 1, leftover 2, partial 3, planned and deleted 0", () => {
    expect(["refused", "leftover", "partial", "planned", "deleted"].map((o) => exitCodeFor(o as never))).toEqual([1, 2, 3, 0, 0]);
  });
});

describe("held (round-2 review)", () => {
  it.each([
    ["comped", { status: "comped" }],
    ["past_due", { status: "past_due", stripeSubscriptionId: "s" }],
    ["pending", { status: "pending", checkoutTokenHash: "h" }],
    ["no status", { planId: "p" }],
    ["status Canceled (case)", { status: "Canceled" }],
  ])("billing %s refuses", async (_, billing) => {
    patchTarget({ billing });
    expect((await run({ yes: false })).result.outcome).toBe("refused");
  });

  it.each([["null", null], ["canceled", { status: "canceled", stripeSubscriptionId: null }]])("billing %s allowed", async (_, billing) => {
    patchTarget({ billing });
    expect((await run({ yes: false })).result.outcome).toBe("planned");
  });

  it.each([["pending", { status: "pending" }], ["missing status", {}], ["paid+pending mix", null]])("charge %s refuses", async (_, c) => {
    if (c) mem.seed("billingCharges/c1", { subAccountId: SA, ...c });
    else {
      mem.seed("billingCharges/c1", { subAccountId: SA, status: "paid" });
      mem.seed("billingCharges/c2", { subAccountId: SA, status: "pending" });
    }
    expect((await run({ yes: false })).result.outcome).toBe("refused");
  });

  it.each([
    ["top-level id", "voice", { vapiAssistantId: "a" }],
    ["nested number only", "voice", { voice: { vapiPhoneNumberId: "pn" } }],
    ["nested assistant only", "voice", { voice: { vapiAssistantId: "a", vapiPhoneNumberId: null } }],
    ["other channel doc", "sms", { voice: { vapiAssistantId: "a" } }],
    ["only the provisioned-from number", "voice", { voice: { vapiAssistantId: null, vapiPhoneNumberId: null, vapiPhoneNumber: "+27100000000" } }],
  ])("voice %s refuses", async (_, channel, d) => {
    mem.seed(`subAccounts/${SA}/aiAgent/${channel}`, d);
    expect((await run({ yes: false })).result.outcome).toBe("refused");
  });

  it.each([["voice null", { voice: null }], ["voice string", { voice: "x" }], ["ids empty", { voice: { vapiAssistantId: "", vapiPhoneNumberId: null, vapiPhoneNumber: null } }]])(
    "voice %s does not crash and does not refuse",
    async (_, d) => {
      mem.seed(`subAccounts/${SA}/aiAgent/voice`, d);
      expect((await run({ yes: false })).result.outcome).toBe("planned");
    }
  );

  it("project / client-email check, the @ boundary included", () => {
    const ok = `firebase-adminsdk-x@${PROJECT}.iam.gserviceaccount.com`;
    expect(projectRefusal(PROJECT, PROJECT, ok)).toBeNull();
    for (const e of [undefined, "", `x@evil-${PROJECT}.iam.gserviceaccount.com`, `x@${PROJECT}.iam.gserviceaccount.com.evil`, `${PROJECT}@appspot.gserviceaccount.com`, "x@other.iam.gserviceaccount.com", `x@${PROJECT.toUpperCase()}.iam.gserviceaccount.com`]) {
      expect(projectRefusal(PROJECT, PROJECT, e)).not.toBeNull();
    }
    expect(projectRefusal(PROJECT, "other", ok)).not.toBeNull();
    expect(projectRefusal(PROJECT, undefined, ok)).not.toBeNull();
  });

  it("the membership scan finds an entry whose userMemberships/{uid} parent doc does not exist, and only for this id", async () => {
    mem.seed(`userMemberships/uid_ghost/subAccounts/${SA}`, { subAccountId: SA });
    mem.seed("userMemberships/uid_ghost/subAccounts/sa_sibling", { subAccountId: "sa_sibling" });
    mem.seed(`userMemberships/uid_ghost/agencies/${AG}`, { agencyId: AG });
    const { result } = await run();
    expect(result.outcome).toBe("deleted");
    expect(mem.read(`userMemberships/uid_ghost/subAccounts/${SA}`)).toBeUndefined();
    expect(mem.read("userMemberships/uid_ghost/subAccounts/sa_sibling")).toBeDefined();
    expect(mem.read(`userMemberships/uid_ghost/agencies/${AG}`)).toBeDefined();
  });
});
