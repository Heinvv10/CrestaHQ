import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * Blind-review items on PR #269: malformed or over-limit tags are refused,
 * never truncated or wiped; tag and custom-field changes are computed from
 * the contact as stored inside the write's transaction; an approve with no
 * pinned values is refused.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { getCapability, CapabilityUserError } = await import("@/lib/ai-suite/capabilities");
const { buildAgentContext } = await import("@/lib/api/agent-context");

const TWELVE = Array.from({ length: 12 }, (_, i) => `tag-${i}`);
const ANN = { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann", phone: "+27821111111", tags: TWELVE, customFields: {} };
beforeEach(() => mem.seed("contacts/c1", ANN));
const tags = () => mem.read("contacts/c1")!.tags;

/** Run `during` once, after the next transaction's body and before its commit. */
function beforeNextCommit(during: () => void) {
  const original = mem.db.runTransaction.bind(mem.db);
  let done = false;
  vi.spyOn(mem.db, "runTransaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>) =>
    original(async (tx) => {
      const out = await fn(tx);
      if (!done) {
        done = true;
        during();
      }
      return out;
    })) as never);
}

describe("malformed tags are refused, never wipe the list", () => {
  it.each([["a string", "vip"], ["a blank entry", [" "]], ["null", null], ["a non-string entry", [1]]])(
    "update_contact with %s → invalid_args, tags unchanged",
    async (_label, value) => {
      expect(await dispatchAgentTool(auth, "update_contact", { contactId: "c1", tags: value })).toMatchObject({ ok: false, code: "invalid_args" });
      expect(tags()).toEqual(TWELVE);
    }
  );

  it("only an explicit [] clears the tags", async () => {
    expect(await dispatchAgentTool(auth, "update_contact", { contactId: "c1", tags: [] })).toMatchObject({ ok: true });
    expect(tags()).toEqual([]);
  });
});

describe("over-limit tags are refused, never truncated", () => {
  it.each([
    ["update_contact with 51 tags", "update_contact", Array.from({ length: 51 }, (_, i) => `t${i}`)],
    ["update_contact with an 81-character tag", "update_contact", ["x".repeat(81)]],
    ["add_tags with an 81-character tag", "add_tags", ["x".repeat(81)]],
  ])("%s → invalid_args, tags unchanged", async (_label, name, value) => {
    expect(await dispatchAgentTool(auth, name, { contactId: "c1", tags: value })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(tags()).toEqual(TWELVE);
  });

  it("12 existing + 1 added → all 13 kept", async () => {
    await dispatchAgentTool(auth, "add_tags", { contactId: "c1", tags: ["new"] });
    expect(tags()).toEqual([...TWELVE, "new"]);
  });

  it("an add that would pass 50 tags is refused whole", async () => {
    const r = await dispatchAgentTool(auth, "add_tags", { contactId: "c1", tags: Array.from({ length: 39 }, (_, i) => `more-${i}`) });
    expect(r).toMatchObject({ ok: false, message: "A contact can carry at most 50 tags." });
    expect(tags()).toEqual(TWELVE);
  });

  it("a 60-character stored tag can be removed by its exact text", async () => {
    const long = "y".repeat(60);
    mem.seed("contacts/c1", { ...ANN, tags: [long, "keep"] });
    await dispatchAgentTool(auth, "remove_tags", { contactId: "c1", tags: [long] });
    expect(tags()).toEqual(["keep"]);
  });
});

describe("read-modify-write is one transaction", () => {
  it("add_tags keeps a tag a person added between the read and the write", async () => {
    beforeNextCommit(() => mem.seed("contacts/c1", { ...mem.read("contacts/c1")!, tags: [...TWELVE, "human"] }));
    expect(await dispatchAgentTool(auth, "add_tags", { contactId: "c1", tags: ["agent"] })).toMatchObject({ ok: true });
    expect(tags()).toEqual([...TWELVE, "human", "agent"]);
  });

  it("update_contact's custom-field merge keeps a field a person set in between", async () => {
    for (const key of ["plan", "note"]) {
      mem.seed(`subAccounts/sa1/customFields/${key}`, { entity: "contact", key, label: key, type: "text" });
    }
    beforeNextCommit(() => mem.seed("contacts/c1", { ...mem.read("contacts/c1")!, customFields: { note: "by a person" } }));
    expect(await dispatchAgentTool(auth, "update_contact", { contactId: "c1", customFields: { plan: "Fibre" } })).toMatchObject({ ok: true });
    expect(mem.read("contacts/c1")!.customFields).toEqual({ note: "by a person", plan: "Fibre" });
  });
});

describe("update_contact_channels approve with nothing pinned", () => {
  it("is refused, never falls back to the args", async () => {
    const cap = getCapability("update_contact_channels")!;
    const ctx = { ...buildAgentContext(auth), approved: { pinned: null } };
    await expect(cap.execute(ctx, { contactId: "c1", phone: "+27829999999" })).rejects.toBeInstanceOf(CapabilityUserError);
    expect(mem.read("contacts/c1")!.phone).toBe(ANN.phone);
  });
});
