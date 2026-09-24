import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { ApiAuthContext } from "@/lib/api/auth";
import type { AiSuiteCapability } from "@/lib/ai-suite/capabilities";

/**
 * dispatchAgentTool is the one choke point for agent tool calls. Real
 * registry + real find_contacts over an in-memory Firestore; fixtures are
 * pushed into the registry to exercise seams no real capability uses yet.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { dispatchAgentTool } = await import("./agent-dispatch");
const { AI_SUITE_CAPABILITIES, CapabilityUserError } = await import(
  "@/lib/ai-suite/capabilities"
);

const auth: ApiAuthContext = {
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

const injected: AiSuiteCapability[] = [];
function inject(
  overrides: Partial<AiSuiteCapability> & { name: string }
): AiSuiteCapability {
  const cap: AiSuiteCapability = {
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel: "fixture",
    description: "fixture",
    parameters: { type: "object", properties: {} },
    validate: (raw) => ({ ok: true, args: (raw ?? {}) as Record<string, unknown> }),
    summarize: () => "fixture",
    execute: vi.fn(async () => ({ resultText: "ran" })),
    ...overrides,
  };
  AI_SUITE_CAPABILITIES.push(cap);
  injected.push(cap);
  return cap;
}

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", agentApiEnabledByAgency: true, timezone: "UTC" });
  mem.seed("subAccounts/sa2", { agencyId: "ag1", agentApiEnabledByAgency: true, timezone: "UTC" });
  mem.seed("subAccounts/sa1/apiKeys/key1", { subAccountId: "sa1", revokedAt: null });
});

afterEach(() => {
  for (const cap of injected.splice(0)) {
    AI_SUITE_CAPABILITIES.splice(AI_SUITE_CAPABILITIES.indexOf(cap), 1);
  }
});

describe("refusals before any capability code runs", () => {
  it("a key without the agent scope → insufficient_scope 403", async () => {
    const cap = inject({ name: "__fixture_read" });
    const r = await dispatchAgentTool({ ...auth, scopes: ["admin"] }, "__fixture_read", {});
    expect(r).toMatchObject({ ok: false, code: "insufficient_scope", httpStatus: 403 });
    expect(cap.execute).not.toHaveBeenCalled();
  });

  it("a test-mode key → test_mode_unsupported 400", async () => {
    const cap = inject({ name: "__fixture_read" });
    const r = await dispatchAgentTool({ ...auth, mode: "test" }, "__fixture_read", {});
    expect(r).toMatchObject({ ok: false, code: "test_mode_unsupported", httpStatus: 400 });
    expect(cap.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["false", { agencyId: "ag1", agentApiEnabledByAgency: false }],
    ["missing", { agencyId: "ag1" }],
  ])("the Agent API gate %s → agent_api_disabled 403", async (_label, doc) => {
    mem.seed("subAccounts/sa1", doc);
    const cap = inject({ name: "__fixture_read" });
    const r = await dispatchAgentTool(auth, "__fixture_read", {});
    expect(r).toMatchObject({ ok: false, code: "agent_api_disabled", httpStatus: 403 });
    expect(cap.execute).not.toHaveBeenCalled();
  });

  it("the gate is read fresh on every call", async () => {
    const cap = inject({ name: "__fixture_read" });
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
    const cap = inject({ name: "__fixture_chat_only", surfaces: ["chat"] });
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
    const cap = inject({
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
    const cap = inject({ name: "__fixture_owner", requiredRole: "agencyOwner" });
    expect(await dispatchAgentTool(auth, "__fixture_owner", {})).toMatchObject({
      code: "not_available",
    });
    expect(cap.execute).not.toHaveBeenCalled();
  });
});

describe("args and approval", () => {
  it("a failed validate → invalid_args 400 with the validate error", async () => {
    const r = await dispatchAgentTool(auth, "find_contacts", {});
    expect(r).toEqual({
      ok: false,
      code: "invalid_args",
      httpStatus: 400,
      message: "a search term is required",
    });
  });

  it("an approval capability → a pending proposal, execute never called", async () => {
    const preview = [{ label: "To", value: "Ann (a***@x.io)" }];
    const cap = inject({
      name: "__fixture_outbound",
      approval: "outbound",
      preview: async () => preview,
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

  it("an approval capability without a preview → internal_error 500, nothing queued", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cap = inject({ name: "__fixture_no_preview", approval: "outbound" });
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

  it("agentArgs narrows the raw args before validate and execute", async () => {
    const validate = vi.fn((raw: unknown) => ({
      ok: true as const,
      args: raw as Record<string, unknown>,
    }));
    const cap = inject({
      name: "__fixture_narrowed",
      validate,
      agentArgs: ({ name }) => ({ name }),
    });
    const r = await dispatchAgentTool(auth, "__fixture_narrowed", {
      name: "Ann",
      whatsappOptedOut: false,
    });
    expect(r).toEqual({ ok: true, resultText: "ran" });
    expect(validate).toHaveBeenCalledWith({ name: "Ann" });
    expect(cap.execute).toHaveBeenCalledWith(expect.anything(), { name: "Ann" });
  });
});

describe("execution", () => {
  it("runs with the key's context", async () => {
    const cap = inject({ name: "__fixture_read" });
    await dispatchAgentTool(auth, "__fixture_read", {});
    expect(cap.execute).toHaveBeenCalledWith(
      {
        uid: "apikey:abcd1234",
        email: "",
        displayName: "Agent key",
        agencyId: "ag1",
        subAccountId: "sa1",
        subAccountRole: "admin",
        apiKey: { keyId: "key1", keyPrefix: "abcd1234", mode: "live", enrolmentCapPerHour: 50 },
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
    inject({
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
    const cap = inject({ name: "__fixture_read" });
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
    const cap = inject({
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
    inject({
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
