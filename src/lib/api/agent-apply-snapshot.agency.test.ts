import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth as subKey, mem, setupDispatchTests } from "@/test/agent-dispatch-harness";
import { appliedDocs, seedSnapshots } from "@/test/snapshot-fixtures";
import type { AgencyApiAuthContext } from "@/lib/api/auth";

/**
 * `apply_snapshot` on an agency key (AGENCY_AGENT_API_PLAN.md A4a-2, owner
 * decisions 2026-10-06). Direct only when the snapshot was captured in this
 * agency AND the target is one this key created (`isKeyCreated`): workflows
 * land `draft`, the persona only where none is set, `createdByUid` = the
 * key's minter. Anything else — an imported snapshot, any other target — is
 * an agency-level `public_change` row and writes nothing. Applying onto the
 * snapshot's own source is refused. Real registry and dispatch over an
 * in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-dispatch-harness")).adminMock());

const { dispatchAgentTool } = await import("./agent-dispatch");
const { getCapability } = await import("@/lib/ai-suite/capabilities");

setupDispatchTests();

const agencyKey: AgencyApiAuthContext = { ...subKey, level: "agency", subAccountId: null, keyLevel: "agency", keyId: "ak1" };
const ON = { apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true };
const HOUR = 60 * 60 * 1000;
const NOT_FOUND = { ok: false, code: "not_found", httpStatus: 404, message: "No such sub-account is available to this key." };
const apply = (subAccountId: string, snapshotId: string, key: AgencyApiAuthContext = agencyKey) =>
  dispatchAgentTool(key, "apply_snapshot", { subAccountId, snapshotId });
/** A sub-account as the key's create_sub_account leaves it. */
const keyCreated = (id: string, over: Record<string, unknown> = {}) =>
  mem.seed(`subAccounts/${id}`, { agencyId: "ag1", name: `Key ${id}`, ...ON, createdByKeyId: "ak1", createdAt: new Date(Date.now() - HOUR), ...over });
const proposals = () => mem.list("agentProposals");
const underNull = () => mem.all().filter((d) => d.path.startsWith("subAccounts/null"));
/** Nothing an apply writes exists for `id`. */
const untouched = (id: string) => {
  expect(appliedDocs(mem, id)).toEqual([]);
  expect(mem.list(`subAccounts/${id}/customFields`)).toEqual([]);
  expect(mem.list(`subAccounts/${id}/snapshotApplies`)).toEqual([]);
  expect(mem.read(`subAccounts/${id}/aiAgent/profile`)).toBeUndefined();
};

beforeEach(() => {
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed("agencies/ag1/apiKeys/ak1", { agencyId: "ag1", createdByUid: "minter1", revokedAt: null });
  mem.seed("subAccounts/old", { agencyId: "ag1", name: "Old Co", ...ON, createdAt: new Date(Date.now() - 400 * 24 * HOUR) });
  keyCreated("kc");
  keyCreated("src");
  seedSnapshots(mem);
});

describe("direct: a captured snapshot onto a key-created target", () => {
  it("writes every entity, workflows draft, persona written, as the minter; agent.write names the snapshot", async () => {
    const r = await apply("kc", "snap_own");
    expect(r).toMatchObject({ ok: true, ref: { kind: "snapshot", id: "snap_own" } });
    expect(proposals()).toEqual([]);
    const docs = appliedDocs(mem, "kc");
    expect(docs.map((d) => d.collection).sort()).toEqual(["forms", "message_templates", "products", "workflows"]);
    expect(docs.every((d) => d.agencyId === "ag1" && d.createdByUid === "minter1")).toBe(true);
    expect(mem.list("workflows").map((w) => w.status)).toEqual(["draft"]);
    expect(mem.list("subAccounts/kc/customFields")).toEqual([expect.objectContaining({ key: "install_date", createdByUid: "minter1" })]);
    expect(mem.read("subAccounts/kc/aiAgent/profile")?.systemPrompt).toMatch(/^Persona /);
    expect(mem.read("subAccounts/kc/snapshotApplies/snap_own")).toMatchObject({ status: "completed" });
    const text = (r as { resultText: string }).resultText;
    expect(text).toContain("1 form, 1 message template, 1 product, 1 workflow (draft), 1 custom field");
    expect(text).toContain("persona written");
    expect(mem.list("auditEvents").filter((e) => e.action === "agent.write")).toEqual([
      expect.objectContaining({ subAccountId: "kc", target: { type: "snapshot", id: "snap_own" }, actor: { type: "api_key", id: "ak1" } }),
    ]);
    expect(underNull()).toEqual([]);
  });

  it("a persona already set is kept, and the result says so", async () => {
    mem.seed("subAccounts/kc/aiAgent/profile", { systemPrompt: "Mine." });
    const r = await apply("kc", "snap_own");
    expect((r as { resultText: string }).resultText).toContain("persona kept");
    expect(mem.read("subAccounts/kc/aiAgent/profile")?.systemPrompt).toBe("Mine.");
  });
});

describe("anything else → an agency-level public_change row, nothing written", () => {
  it.each([
    ["created 73 h ago", () => keyCreated("kc", { createdAt: new Date(Date.now() - 73 * HOUR) })],
    ["with one contact", () => mem.seed("contacts/c1", { subAccountId: "kc", agencyId: "ag1", name: "Ann" })],
    ["with a channel connection", () => keyCreated("kc", { twilioConfig: { accountSid: "AC1" } })],
    ["created by a different key", () => keyCreated("kc", { createdByKeyId: "ak2" })],
    ["created by no key", () => keyCreated("kc", { createdByKeyId: undefined })],
  ])("a captured snapshot onto a target %s", async (_label, arrange) => {
    arrange();
    expect(await apply("kc", "snap_own")).toMatchObject({ ok: true, proposal: { status: "pending" } });
    expect(proposals()).toEqual([
      expect.objectContaining({
        subAccountId: null, agencyId: "ag1", keyLevel: "agency", keyId: "ak1", targetScoped: false,
        targetSubAccountId: "kc", approval: "public_change", capability: "apply_snapshot",
        args: { subAccountId: "kc", snapshotId: "snap_own" },
      }),
    ]);
    untouched("kc");
    expect(underNull()).toEqual([]);
  });

  it("an imported snapshot, even onto a key-created target", async () => {
    expect(await apply("kc", "snap_imp")).toMatchObject({ ok: true, proposal: { status: "pending" } });
    expect(proposals()).toEqual([expect.objectContaining({ approval: "public_change", targetSubAccountId: "kc", subAccountId: null })]);
    untouched("kc");
  });

  it("the preview names target, snapshot, what is created and skipped, drafts, live forms and the persona; pins the payload", async () => {
    await apply("old", "snap_own");
    const [row] = proposals();
    const preview = Object.fromEntries((row!.preview as Array<{ label: string; value: string }>).map((p) => [p.label, p.value]));
    expect(preview).toEqual({
      "Sub-account": "Old Co",
      Snapshot: "“Onboarding kit”, captured from another of this agency's sub-accounts",
      Creates: "1 form, 1 message template, 1 product, 1 workflow, 1 custom field",
      Skips: "nothing (none of it is there yet)",
      Workflows: "Arrive as drafts: none runs until someone activates it.",
      Forms: "Copied with their status: 1 accepts public submissions on this sub-account at once.",
      "AI persona": "Written (none set); sets the AI's hours and timezone to the snapshot's (8:00–17:00 UTC)",
    });
    expect(row!.pinned).toEqual({ snapshotId: "snap_own", payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    untouched("old");
  });

  it("the preview of an imported snapshot says where it came from; a set persona reads kept", async () => {
    mem.seed("subAccounts/old/aiAgent/profile", { systemPrompt: "Theirs." });
    await apply("old", "snap_imp");
    const preview = Object.fromEntries((proposals()[0]!.preview as Array<{ label: string; value: string }>).map((p) => [p.label, p.value]));
    expect(preview.Snapshot).toBe("“Bought kit”, imported: its persona, forms and workflows were written outside this agency");
    expect(preview["AI persona"]).toBe("Kept (target already has one)");
  });

  it("a persona to be written names the AI channels switched on here, which start replying with it", async () => {
    mem.seed("subAccounts/old/aiAgent/whatsapp", { enabled: true });
    mem.seed("subAccounts/old/aiAgent/web-chat", { enabled: true });
    mem.seed("subAccounts/old/aiAgent/sms", { enabled: false });
    await apply("old", "snap_own");
    const preview = Object.fromEntries((proposals()[0]!.preview as Array<{ label: string; value: string }>).map((p) => [p.label, p.value]));
    expect(preview["AI persona"]).toBe(
      "Written (none set); sets the AI's hours and timezone to the snapshot's (8:00–17:00 UTC); web-chat, whatsapp start replying to customers with it at once"
    );
  });
});

describe("refusals: nothing written, nothing queued", () => {
  it.each([["key-created", () => undefined], ["not key-created", () => keyCreated("src", { createdByKeyId: "ak2" })]])(
    "onto the snapshot's own source (%s) → 400",
    async (_label, arrange) => {
      arrange();
      expect(await apply("src", "snap_own")).toMatchObject({
        ok: false, code: "invalid_request", httpStatus: 400, message: expect.stringContaining("its own source"),
      });
      expect(proposals()).toEqual([]);
      untouched("src");
    }
  );

  it("an unknown snapshot and another agency's give one identical 404", async () => {
    const unknown = await apply("kc", "snap_missing");
    expect(unknown).toMatchObject({ ok: false, code: "not_found", httpStatus: 404 });
    expect(await apply("kc", "snap_other")).toEqual(unknown);
    expect(await apply("old", "snap_other")).toEqual(unknown);
    expect(proposals()).toEqual([]);
    untouched("kc");
  });

  it("a snapshotId that is not a doc id → invalid_args", async () => {
    for (const snapshotId of ["", "a/b", "..", undefined]) {
      expect(await apply("kc", snapshotId as string), String(snapshotId)).toMatchObject({ ok: false, code: "invalid_args", httpStatus: 400 });
    }
  });

  it("an unreachable target gets the identical 404 whatever the snapshot", async () => {
    mem.seed("subAccounts/sb1", { agencyId: "ag2", name: "Two", ...ON });
    mem.seed("subAccounts/off", { agencyId: "ag1", name: "Off", ...ON, agentApiEnabledByAgency: false });
    for (const target of ["sb1", "off", "missing", " kc"]) {
      for (const snap of ["snap_own", "snap_imp", "snap_missing"]) expect(await apply(target, snap), `${target} ${snap}`).toEqual(NOT_FOUND);
    }
    expect(proposals()).toEqual([]);
  });

  it("a sub-account key cannot call it", async () => {
    expect(await dispatchAgentTool(subKey, "apply_snapshot", { snapshotId: "snap_own" })).toMatchObject({ code: "not_available", httpStatus: 404 });
  });
});

describe("execute re-checks at write time", () => {
  const cap = () => getCapability("apply_snapshot")!;
  const keyCtx = {
    uid: "apikey:abcd1234", email: "", displayName: "", agencyId: "ag1",
    apiKey: { keyId: "ak1", keyPrefix: "abcd1234", keyLevel: "agency" as const, mode: "live" as const, enrolmentCapPerHour: 50 },
  };

  it("a target that gained a contact since dispatch is refused unapproved", async () => {
    mem.seed("contacts/c1", { subAccountId: "kc", agencyId: "ag1", name: "Ann" });
    await expect(cap().execute(keyCtx, { subAccountId: "kc", snapshotId: "snap_own" })).rejects.toThrow(/approval/);
    untouched("kc");
  });

  it("the re-check is the last read before the write: a contact landing while the minter is read is refused", async () => {
    // The minter's key doc is reached through collection("agencies") (apiKeyRef).
    const orig = mem.db.collection.bind(mem.db);
    const spy = vi.spyOn(mem.db, "collection").mockImplementation((name: string) => {
      if (name === "agencies") mem.seed("contacts/c_late", { subAccountId: "kc", agencyId: "ag1", name: "Late" });
      return orig(name);
    });
    try {
      await expect(cap().execute(keyCtx, { subAccountId: "kc", snapshotId: "snap_own" })).rejects.toThrow(/approval/);
    } finally {
      spy.mockRestore();
    }
    untouched("kc");
  });

  it("a malformed payload applies nothing instead of failing", async () => {
    mem.seed("agencies/ag1/snapshots/snap_bad", {
      agencyId: "ag1", name: "Corrupt", description: "", sourceSubAccountId: "src", createdAt: new Date(),
      payload: { forms: "x", messageTemplates: [null, 3], products: null, workflows: { w: 1 }, customFields: 5, aiProfile: "prompt" },
    });
    const direct = await apply("kc", "snap_bad");
    expect(direct).toMatchObject({ ok: true, resultText: expect.stringContaining("created 0 forms, 0 message templates, 0 products, 0 workflows, 0 custom fields; no persona") });
    expect(appliedDocs(mem, "kc")).toEqual([]);
    expect(mem.list("subAccounts/kc/customFields")).toEqual([]);
    expect(mem.read("subAccounts/kc/aiAgent/profile")).toBeUndefined();
    expect(await apply("old", "snap_bad")).toMatchObject({ ok: true, proposal: { status: "pending" } });
    expect(mem.list("agencies/ag1/snapshots").length).toBeGreaterThan(0);
  });

  it("an imported snapshot, no ctx.approved, and another agency's target are refused", async () => {
    await expect(cap().execute(keyCtx, { subAccountId: "kc", snapshotId: "snap_imp" })).rejects.toThrow(/approval/);
    const owner = { uid: "owner1", email: "", displayName: "", agencyId: "ag1" };
    await expect(cap().execute(owner, { subAccountId: "kc", snapshotId: "snap_own" })).rejects.toThrow(/approval/);
    mem.seed("subAccounts/sb1", { agencyId: "ag2", name: "Two", ...ON });
    await expect(cap().execute({ ...owner, approved: { pinned: null } }, { subAccountId: "sb1", snapshotId: "snap_own" })).rejects.toThrow(/wasn't found/);
    untouched("kc");
    untouched("sb1");
  });

  it("approved, self-apply and a vanished snapshot are still refused", async () => {
    const owner = { uid: "owner1", email: "", displayName: "", agencyId: "ag1", approved: { pinned: null } };
    await expect(cap().execute(owner, { subAccountId: "src", snapshotId: "snap_own" })).rejects.toThrow(/its own source/);
    await expect(cap().execute(owner, { subAccountId: "kc", snapshotId: "snap_missing" })).rejects.toThrow(/No snapshot/);
    untouched("src");
    untouched("kc");
  });

  it("the preview re-anchors the target to the caller's agency", async () => {
    mem.seed("subAccounts/sb1", { agencyId: "ag2", name: "Two", ...ON });
    const owner = { uid: "owner1", email: "", displayName: "", agencyId: "ag1", subAccountId: "sb1" };
    await expect(cap().preview!(owner, { subAccountId: "sb1", snapshotId: "snap_own" })).rejects.toThrow(/wasn't found in this agency/);
  });

  it("the pinned payload hash ignores key order, nested included", async () => {
    const forward = { products: [{ name: "Install", active: true }], aiProfile: { timezone: "UTC", systemPrompt: "Hi" } };
    const reversed = { aiProfile: { systemPrompt: "Hi", timezone: "UTC" }, products: [{ active: true, name: "Install" }] };
    const base = { agencyId: "ag1", name: "Order", description: "", sourceSubAccountId: "src", createdAt: new Date() };
    mem.seed("agencies/ag1/snapshots/snap_fwd", { ...base, payload: forward });
    mem.seed("agencies/ag1/snapshots/snap_rev", { ...base, payload: reversed });
    const owner = { uid: "owner1", email: "", displayName: "", agencyId: "ag1", subAccountId: "old" };
    const hash = async (snapshotId: string) => {
      const p = await cap().preview!(owner, { subAccountId: "old", snapshotId });
      return (Array.isArray(p) ? null : p.pinned?.payloadSha256) as string;
    };
    expect(await hash("snap_fwd")).toMatch(/^[0-9a-f]{64}$/);
    expect(await hash("snap_fwd")).toBe(await hash("snap_rev"));
  });

  it("approved, a payload other than the one pinned (or none pinned) is refused; the reviewed one applies", async () => {
    const owner = { uid: "owner1", email: "", displayName: "", agencyId: "ag1" };
    const args = { subAccountId: "old", snapshotId: "snap_own" };
    for (const pinned of [null, { snapshotId: "snap_own", payloadSha256: "0".repeat(64) }]) {
      await expect(cap().execute({ ...owner, approved: { pinned } }, args)).rejects.toThrow(/changed since it was reviewed/);
    }
    untouched("old");
    const reviewed = await cap().preview!({ ...owner, subAccountId: "old" }, args);
    const pinned = Array.isArray(reviewed) ? null : reviewed.pinned!;
    await expect(cap().execute({ ...owner, approved: { pinned } }, args)).resolves.toMatchObject({ ref: { kind: "snapshot", id: "snap_own" } });
    expect(appliedDocs(mem, "old")).toHaveLength(4);
  });
});
