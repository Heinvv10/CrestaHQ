import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth as subKey, mem, setupDispatchTests } from "@/test/agent-dispatch-harness";
import type { AgencyApiAuthContext } from "@/lib/api/auth";

/**
 * `set_sub_account_gate` on an agency key (AGENCY_AGENT_API_PLAN.md D3/D4,
 * A4a-1). A DIRECT gate on a key-created target (this key's, < 72 h old, no
 * contacts, no channel connection) is written at once, through the same
 * gate path and audit as the Manage dialog; anything else is an agency-level
 * `gate_change` row, and enabling an ENABLE_REFUSED gate is refused outright.
 * Reach runs first: an unreachable target gets the identical 404. On approval
 * the row runs the capability's own execute. Real registry and dispatch over
 * an in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-dispatch-harness")).adminMock());

const { dispatchAgentTool } = await import("./agent-dispatch");
const { getCapability } = await import("@/lib/ai-suite/capabilities");
const { canonical } = await import("@/lib/server/agent-proposals-encoding");

setupDispatchTests();

const agencyKey: AgencyApiAuthContext = { ...subKey, level: "agency", subAccountId: null, keyLevel: "agency", keyId: "ak1" };
const ON = { apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true };
const HOUR = 60 * 60 * 1000;
const NOT_FOUND = { ok: false, code: "not_found", httpStatus: 404, message: "No such sub-account is available to this key." };
const setGate = (subAccountId: string, gate: string, enabled: boolean) =>
  dispatchAgentTool(agencyKey, "set_sub_account_gate", { subAccountId, gate, enabled });
/** The key-created target, as the key's create_sub_account leaves it. */
const keyCreated = (over: Record<string, unknown> = {}) =>
  mem.seed("subAccounts/kc", {
    agencyId: "ag1", name: "Key Co", ...ON, createdByKeyId: "ak1", createdAt: new Date(Date.now() - HOUR),
    labsEnabledByAgency: false, whatsappEnabledByAgency: false, twilioConfig: null, resendConfig: null, metaConfig: null,
    ...over,
  });
const proposals = () => mem.list("agentProposals");
const gateAudits = () => mem.list("auditEvents").filter((e) => e.action === "feature_gates.updated");

beforeEach(() => {
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed("agencies/ag1/apiKeys/ak1", { agencyId: "ag1", createdByUid: "owner1", revokedAt: null });
  mem.seed("subAccounts/old", {
    agencyId: "ag1", name: "Old Co", ...ON, createdAt: new Date(Date.now() - 400 * 24 * HOUR), googleEnabledByAgency: true,
  });
  keyCreated();
});

describe("direct: a DIRECT gate on a key-created target", () => {
  it.each([true, false])("labs %s → written, audited as the key, no proposal", async (on) => {
    keyCreated({ labsEnabledByAgency: !on });
    expect(await setGate("kc", "labs", on)).toMatchObject({ ok: true, ref: { kind: "subAccount", id: "kc" } });
    expect(mem.read("subAccounts/kc")?.labsEnabledByAgency).toBe(on);
    expect(gateAudits()).toEqual([
      expect.objectContaining({ subAccountId: "kc", actor: { type: "api_key", id: "ak1" }, changes: [{ field: "labsEnabledByAgency", before: !on, after: on }] }),
    ]);
    expect(mem.list("auditEvents").filter((e) => e.action === "agent.write")).toEqual([expect.objectContaining({ subAccountId: "kc" })]);
    expect(proposals()).toEqual([]);
  });
});

describe("anything short of key-created → a gate_change proposal, nothing written", () => {
  it.each([
    ["created 73 h ago", () => keyCreated({ createdAt: new Date(Date.now() - 73 * HOUR) })],
    ["with one contact", () => mem.seed("contacts/c1", { subAccountId: "kc", agencyId: "ag1", name: "Ann" })],
    ["with a channel connection", () => keyCreated({ twilioConfig: { accountSid: "AC1" } })],
    ["created by a different key", () => keyCreated({ createdByKeyId: "ak2" })],
    ["created by no key", () => keyCreated({ createdByKeyId: undefined })],
  ])("labs true on a target %s", async (_label, arrange) => {
    arrange();
    expect(await setGate("kc", "labs", true)).toMatchObject({ ok: true, proposal: { status: "pending" } });
    expect(mem.read("subAccounts/kc")?.labsEnabledByAgency).toBe(false);
    expect(proposals()).toEqual([expect.objectContaining({ approval: "gate_change", targetSubAccountId: "kc" })]);
    expect(gateAudits()).toEqual([]);
  });
});

describe("a PROPOSAL gate → an agency-level gate_change row, even on a key-created target", () => {
  it("whatsapp true: the row's fields, its id and its preview", async () => {
    const r = await setGate("kc", "whatsapp", true);
    expect(r).toMatchObject({ ok: true, proposal: { status: "pending" } });
    const args = { subAccountId: "kc", gate: "whatsapp", enabled: true };
    const id = `p_${createHash("sha256").update(`agency:ag1|set_sub_account_gate|${canonical(args)}`).digest("hex").slice(0, 40)}`;
    expect((r as { proposal: { id: string } }).proposal.id).toBe(id);
    const row = mem.read(`agentProposals/${id}`)!;
    expect(row).toMatchObject({
      subAccountId: null, agencyId: "ag1", keyLevel: "agency", keyId: "ak1", targetScoped: false,
      targetSubAccountId: "kc", approval: "gate_change", capability: "set_sub_account_gate", args, status: "pending",
    });
    const preview = Object.fromEntries((row.preview as Array<{ label: string; value: string }>).map((p) => [p.label, p.value]));
    expect(preview).toMatchObject({ "Sub-account": "Key Co", Gate: "WhatsApp", Change: "Switch on" });
    expect(preview["Side effect"]).toMatch(/inbound WhatsApp/i);
    expect(mem.read("subAccounts/kc")?.whatsappEnabledByAgency).toBe(false);
    expect(mem.all().filter((d) => d.path.startsWith("subAccounts/null"))).toEqual([]);
  });

  it("google false on an existing (not key-created) target → proposal naming the review-cache deletion", async () => {
    expect(await setGate("old", "google", false)).toMatchObject({ ok: true, proposal: { status: "pending" } });
    expect(mem.read("subAccounts/old")?.googleEnabledByAgency).toBe(true);
    const [row] = proposals();
    expect(row).toMatchObject({ targetSubAccountId: "old", subAccountId: null, approval: "gate_change" });
    expect(JSON.stringify(row!.preview)).toMatch(/review cache/i);
  });
});

describe("ENABLE_REFUSED: refused outright, never a proposal", () => {
  it.each(["agent-api", "api-access", "reviews-auto-reply"])("%s true → 400, nothing queued or written", async (gate) => {
    const before = mem.read("subAccounts/kc");
    expect(await setGate("kc", gate, true)).toMatchObject({ ok: false, code: "invalid_args", httpStatus: 400 });
    expect(proposals()).toEqual([]);
    expect(mem.read("subAccounts/kc")).toEqual(before);
  });
});

describe("gate names are FEATURE_GATES' own keys, never Object.prototype's", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("%s → invalid_args, nothing queued or written", async (gate) => {
    const before = mem.read("subAccounts/kc");
    expect(await setGate("kc", gate, true)).toMatchObject({ ok: false, code: "invalid_args", httpStatus: 400 });
    expect(proposals()).toEqual([]);
    expect(mem.read("subAccounts/kc")).toEqual(before);
  });
});

describe("reach runs on the target first", () => {
  it("every unreachable target gets the identical 404, whatever the gate", async () => {
    mem.seed("subAccounts/sa2", { agencyId: "ag2", name: "Two", ...ON });
    mem.seed("subAccounts/sa3", { agencyId: "ag1", name: "Three", ...ON, agentApiEnabledByAgency: false });
    mem.seed("subAccounts/sa5", { agencyId: "ag1", name: "Five", ...ON, apiAccessEnabledByAgency: false });
    for (const target of ["sa2", "sa3", "sa5", "sa_missing", " kc", "kc "]) {
      for (const [gate, on] of [["labs", true], ["whatsapp", true], ["agent-api", true]] as const) {
        expect(await setGate(target, gate, on), `${target} ${gate}`).toEqual(NOT_FOUND);
      }
    }
    expect(await dispatchAgentTool(agencyKey, "set_sub_account_gate", { gate: "labs", enabled: true })).toMatchObject({
      ok: false, code: "invalid_args",
    });
    expect(proposals()).toEqual([]);
    expect(gateAudits()).toEqual([]);
  });
});

describe("executing a gate_change row (the A5 approve route's execute)", () => {
  const cap = () => getCapability("set_sub_account_gate")!;
  const owner = { uid: "owner1", email: "owner@example.com", displayName: "", agencyId: "ag1" };

  it("approved: writes through the gate path, audited as the approving owner, side effect included", async () => {
    await setGate("old", "google", false);
    const [row] = proposals();
    await cap().execute({ ...owner, subAccountId: "old", approved: { pinned: null, proposalId: row!.id, claimId: "c1" } }, row!.args as Record<string, unknown>);
    expect(mem.read("subAccounts/old")?.googleEnabledByAgency).toBe(false);
    expect(gateAudits()).toEqual([expect.objectContaining({ subAccountId: "old", actor: { type: "user", id: "owner1" } })]);
  });

  it("unapproved on a target that stopped being key-created: refused at write time, nothing written", async () => {
    const keyCtx = { uid: "apikey:abcd1234", email: "", displayName: "", agencyId: "ag1", apiKey: { keyId: "ak1", keyPrefix: "abcd1234", keyLevel: "agency" as const, mode: "live" as const, enrolmentCapPerHour: 50 } };
    mem.seed("contacts/c1", { subAccountId: "kc", agencyId: "ag1", name: "Ann" });
    await expect(cap().execute(keyCtx, { subAccountId: "kc", gate: "labs", enabled: true })).rejects.toThrow(/approval/);
    await expect(cap().execute(owner, { subAccountId: "kc", gate: "labs", enabled: true })).rejects.toThrow(/approval/);
    expect(mem.read("subAccounts/kc")?.labsEnabledByAgency).toBe(false);
  });

  it.each(["agent-api", "api-access"])("approved, %s true is still refused at execute, nothing written", async (gate) => {
    const before = mem.read("subAccounts/kc");
    await expect(
      cap().execute({ ...owner, approved: { pinned: null } }, { subAccountId: "kc", gate, enabled: true }),
    ).rejects.toThrow(/only be switched on by the agency owner/);
    expect(mem.read("subAccounts/kc")).toEqual(before);
    expect(gateAudits()).toEqual([]);
  });

  it("approved, a prototype gate name (constructor) is refused at execute, nothing written", async () => {
    const before = mem.read("subAccounts/kc");
    await expect(
      cap().execute({ ...owner, approved: { pinned: null } }, { subAccountId: "kc", gate: "constructor", enabled: true }),
    ).rejects.toThrow(/pick a gate/);
    expect(mem.read("subAccounts/kc")).toEqual(before);
  });

  it("another agency's sub-account is refused even approved", async () => {
    mem.seed("subAccounts/sa2", { agencyId: "ag2", name: "Two", ...ON, labsEnabledByAgency: false });
    await expect(
      cap().execute({ ...owner, approved: { pinned: null } }, { subAccountId: "sa2", gate: "labs", enabled: true }),
    ).rejects.toThrow(/wasn't found/);
    expect(mem.read("subAccounts/sa2")?.labsEnabledByAgency).toBe(false);
  });
});
