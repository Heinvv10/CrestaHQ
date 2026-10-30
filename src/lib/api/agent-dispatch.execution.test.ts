import { describe, expect, it, vi } from "vitest";
import { auth, inject, mem, setupDispatchTests } from "@/test/agent-dispatch-harness";

/**
 * dispatchAgentTool once every refusal has passed: an approval capability
 * becomes an agentProposals row (never executed), anything else executes with
 * the key's context, and every throw maps to a safe error.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-dispatch-harness")).adminMock());

const { dispatchAgentTool } = await import("./agent-dispatch");
const { CapabilityUserError } = await import("@/lib/ai-suite/capabilities");

setupDispatchTests();
const tenantWide = async () => ({ contactId: null, territoryId: null, scoped: false });

describe("approval capabilities", () => {
  it("an approval capability → a pending proposal, execute never called", async () => {
    const preview = [{ label: "To", value: "Ann (a***@x.io)" }];
    const cap = await inject({
      name: "__fixture_outbound",
      approval: "outbound",
      preview: async () => ({ rows: preview, pinned: { to: "a@x.io" } }),
      approvalTarget: tenantWide,
    });
    const r = await dispatchAgentTool(auth, "__fixture_outbound", { body: "hi" });
    expect(r).toMatchObject({
      ok: true,
      proposal: { status: "pending", summary: "fixture", preview },
    });
    const id = (r as { proposal: { id: string } }).proposal.id;
    expect(mem.read(`agentProposals/${id}`)).toMatchObject({
      agencyId: "ag1",
      subAccountId: "sa1",
      createdByUid: "apikey:abcd1234",
      keyId: "key1",
      capability: "__fixture_outbound",
      approval: "outbound",
      args: { body: "hi" },
      status: "pending",
    });
    // The same call again is the same pending row, not a second one.
    expect(await dispatchAgentTool(auth, "__fixture_outbound", { body: "hi" })).toEqual(r);
    expect(mem.list("agentProposals")).toHaveLength(1);
    expect(cap.execute).not.toHaveBeenCalled();
  });

  it("G6: an outbound capability whose preview pins nothing → internal_error 500, logged, nothing queued", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cap = await inject({
      name: "__fixture_unpinned",
      approval: "outbound",
      preview: async () => [{ label: "To", value: "Ann" }],
      approvalTarget: tenantWide,
    });
    expect(await dispatchAgentTool(auth, "__fixture_unpinned", {})).toMatchObject({ code: "internal_error", httpStatus: 500 });
    expect(logged).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: "__fixture_unpinned is outbound but its preview pins nothing" })
    );
    expect(mem.list("agentProposals")).toEqual([]);
    expect(cap.execute).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("a non-outbound approval (hard_delete) needs no pinned values", async () => {
    await inject({
      name: "__fixture_delete",
      approval: "hard_delete",
      preview: async () => [{ label: "Delete", value: "Ann" }],
      approvalTarget: tenantWide,
    });
    expect(await dispatchAgentTool(auth, "__fixture_delete", {})).toMatchObject({ ok: true, proposal: { status: "pending" } });
  });

  it("H4: an approval capability without an approvalTarget → internal_error 500, logged, nothing queued", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cap = await inject({
      name: "__fixture_no_target",
      approval: "hard_delete",
      preview: async () => [{ label: "Delete", value: "Ann" }],
    });
    expect(await dispatchAgentTool(auth, "__fixture_no_target", {})).toMatchObject({ code: "internal_error", httpStatus: 500 });
    expect(logged).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: "__fixture_no_target has approval but no approvalTarget" })
    );
    expect(mem.list("agentProposals")).toEqual([]);
    expect(cap.execute).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("an approval capability without a preview → internal_error 500, nothing queued", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cap = await inject({ name: "__fixture_no_preview", approval: "outbound", approvalTarget: tenantWide });
    expect(await dispatchAgentTool(auth, "__fixture_no_preview", {})).toMatchObject({
      code: "internal_error",
      httpStatus: 500,
    });
    expect(mem.list("agentProposals")).toEqual([]);
    expect(cap.execute).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: "__fixture_no_preview has approval but no preview" })
    );
    logged.mockRestore();
  });
});

describe("execution", () => {
  it("runs with the key's context", async () => {
    const cap = await inject({ name: "__fixture_read" });
    await dispatchAgentTool(auth, "__fixture_read", {});
    expect(cap.execute).toHaveBeenCalledWith(
      {
        uid: "apikey:abcd1234",
        email: "",
        displayName: "Agent key",
        agencyId: "ag1",
        subAccountId: "sa1",
        subAccountRole: "admin",
        apiKey: { keyId: "key1", keyPrefix: "abcd1234", keyLevel: "sub-account", mode: "live", enrolmentCapPerHour: 50 },
      },
      {}
    );
  });

  it("find_contacts returns only the key's own sub-account's contacts", async () => {
    mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Ann Own", email: "own@x.io" });
    mem.seed("contacts/c2", { agencyId: "ag1", subAccountId: "sa2", name: "Ann Other", email: "other@x.io" });
    const r = await dispatchAgentTool(auth, "find_contacts", { query: "ann" });
    expect(r.ok).toBe(true);
    const text = (r as { resultText: string }).resultText;
    expect(text).toContain("Ann Own");
    expect(text).not.toContain("Ann Other");
  });

  it("a CapabilityUserError → invalid_request 400 with its message", async () => {
    await inject({
      name: "__fixture_user_error",
      execute: async () => {
        throw new CapabilityUserError("That contact isn't in this workspace.");
      },
    });
    expect(await dispatchAgentTool(auth, "__fixture_user_error", {})).toEqual({
      ok: false,
      code: "invalid_request",
      httpStatus: 400,
      message: "That contact isn't in this workspace.",
    });
  });

  it("a throw before execute (the gate read) → internal_error 500, logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cap = await inject({ name: "__fixture_read" });
    const doc = vi.spyOn(mem.db, "doc").mockImplementation(() => {
      throw new Error("firestore unavailable");
    });
    const r = await dispatchAgentTool(auth, "__fixture_read", {});
    doc.mockRestore();
    expect(r).toEqual({
      ok: false,
      code: "internal_error",
      httpStatus: 500,
      message: "The tool failed to run.",
    });
    expect(logged).toHaveBeenCalled();
    expect(cap.execute).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("a throw from agentArgs → internal_error 500", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cap = await inject({
      name: "__fixture_bad_narrow",
      agentArgs: () => {
        throw new Error("boom");
      },
    });
    expect(await dispatchAgentTool(auth, "__fixture_bad_narrow", {})).toMatchObject({
      code: "internal_error",
      httpStatus: 500,
    });
    expect(cap.execute).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("any other throw → internal_error 500 without leaking the message", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await inject({
      name: "__fixture_crash",
      execute: async () => {
        throw new Error("secret internal detail");
      },
    });
    const r = await dispatchAgentTool(auth, "__fixture_crash", {});
    expect(r).toMatchObject({ ok: false, code: "internal_error", httpStatus: 500 });
    expect(JSON.stringify(r)).not.toContain("secret internal detail");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
