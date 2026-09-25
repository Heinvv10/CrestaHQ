import { describe, expect, it, vi } from "vitest";
import { auth, inject, mem, setupDispatchTests } from "@/test/agent-dispatch-harness";

/**
 * dispatchAgentTool is the one choke point for agent tool calls: its
 * refusals and arg handling (execution and the approval-queue write are in
 * agent-dispatch.execution.test.ts). Real registry over an in-memory
 * Firestore; fixtures are pushed into it to exercise seams no real
 * capability uses yet.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-dispatch-harness")).adminMock());

const { dispatchAgentTool } = await import("./agent-dispatch");
const { AI_SUITE_CAPABILITIES } = await import("@/lib/ai-suite/capabilities");

setupDispatchTests();

describe("refusals before any capability code runs", () => {
  it("a key without the agent scope → insufficient_scope 403", async () => {
    const cap = await inject({ name: "__fixture_read" });
    const r = await dispatchAgentTool({ ...auth, scopes: ["admin"] }, "__fixture_read", {});
    expect(r).toMatchObject({ ok: false, code: "insufficient_scope", httpStatus: 403 });
    expect(cap.execute).not.toHaveBeenCalled();
  });

  it("a test-mode key → test_mode_unsupported 400", async () => {
    const cap = await inject({ name: "__fixture_read" });
    const r = await dispatchAgentTool({ ...auth, mode: "test" }, "__fixture_read", {});
    expect(r).toMatchObject({ ok: false, code: "test_mode_unsupported", httpStatus: 400 });
    expect(cap.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["false", { agencyId: "ag1", agentApiEnabledByAgency: false }],
    ["missing", { agencyId: "ag1" }],
  ])("the Agent API gate %s → agent_api_disabled 403", async (_label, doc) => {
    mem.seed("subAccounts/sa1", doc);
    const cap = await inject({ name: "__fixture_read" });
    const r = await dispatchAgentTool(auth, "__fixture_read", {});
    expect(r).toMatchObject({ ok: false, code: "agent_api_disabled", httpStatus: 403 });
    expect(cap.execute).not.toHaveBeenCalled();
  });

  it("the gate is read fresh on every call", async () => {
    const cap = await inject({ name: "__fixture_read" });
    expect(await dispatchAgentTool(auth, "__fixture_read", {})).toMatchObject({ ok: true });
    mem.seed("subAccounts/sa1", { agencyId: "ag1", agentApiEnabledByAgency: false });
    expect(await dispatchAgentTool(auth, "__fixture_read", {})).toMatchObject({
      code: "agent_api_disabled",
    });
    expect(cap.execute).toHaveBeenCalledTimes(1);
  });

  it("a chat-only capability → not_available, never executed", async () => {
    const real = AI_SUITE_CAPABILITIES.find((c) => c.name === "create_webhook")!;
    expect(real.surfaces).toEqual(["chat"]);
    const spy = vi.spyOn(real, "execute");
    const cap = await inject({ name: "__fixture_chat_only", surfaces: ["chat"] });
    for (const name of ["create_webhook", "__fixture_chat_only"]) {
      expect(await dispatchAgentTool(auth, name, {})).toEqual({
        ok: false,
        code: "not_available",
        httpStatus: 404,
        message: "No such tool is available to this key.",
      });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(cap.execute).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it.each([
    "my_access",
    "open_workspace",
    "invite_member",
    "create_community",
    "research_website_reference",
    "get_website_prefill",
    "create_website",
    "check_website_status",
    "create_webhook",
    "update_webhook_url",
    "send_webhook_test",
  ])("spec-excluded %s → not_available, never executed", async (name) => {
    const real = AI_SUITE_CAPABILITIES.find((c) => c.name === name)!;
    const spy = vi.spyOn(real, "execute");
    expect(await dispatchAgentTool(auth, name, {})).toMatchObject({
      ok: false,
      code: "not_available",
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("an agency-level capability any role satisfies → not_available (level guard alone)", async () => {
    const cap = await inject({
      name: "__fixture_agency",
      level: "agency",
      requiredRole: "subAccountMember",
    });
    expect(await dispatchAgentTool(auth, "__fixture_agency", {})).toMatchObject({
      code: "not_available",
    });
    expect(cap.execute).not.toHaveBeenCalled();
  });

  it("refusals are fresh objects, not a shared mutable one", async () => {
    const a = await dispatchAgentTool(auth, "no_such_tool", {});
    const b = await dispatchAgentTool(auth, "no_such_tool", {});
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("agency-level and unknown names get the same not_available response", async () => {
    const results = await Promise.all(
      ["list_sub_accounts", "find_contacts_in_sub_account", "no_such_tool"].map((n) =>
        dispatchAgentTool(auth, n, { query: "a" })
      )
    );
    for (const r of results) {
      expect(r).toEqual({
        ok: false,
        code: "not_available",
        httpStatus: 404,
        message: "No such tool is available to this key.",
      });
    }
  });

  it("a role the key cannot satisfy → not_available", async () => {
    const cap = await inject({ name: "__fixture_owner", requiredRole: "agencyOwner" });
    expect(await dispatchAgentTool(auth, "__fixture_owner", {})).toMatchObject({
      code: "not_available",
    });
    expect(cap.execute).not.toHaveBeenCalled();
  });
});

describe("args", () => {
  it("a failed validate → invalid_args 400 with the validate error", async () => {
    const r = await dispatchAgentTool(auth, "find_contacts", {});
    expect(r).toEqual({
      ok: false,
      code: "invalid_args",
      httpStatus: 400,
      message: "a search term is required",
    });
  });

  it("agentArgs narrows the raw args before validate and execute", async () => {
    const validate = vi.fn((raw: unknown) => ({
      ok: true as const,
      args: raw as Record<string, unknown>,
    }));
    const cap = await inject({
      name: "__fixture_narrowed",
      validate,
      agentArgs: ({ name }) => ({ name }),
    });
    const r = await dispatchAgentTool(auth, "__fixture_narrowed", {
      name: "Ann",
      whatsappOptedOut: false,
    });
    expect(r).toEqual({ ok: true, resultText: "ran", args: { name: "Ann" } });
    expect(validate).toHaveBeenCalledWith({ name: "Ann" });
    expect(cap.execute).toHaveBeenCalledWith(expect.anything(), { name: "Ann" });
  });
});
