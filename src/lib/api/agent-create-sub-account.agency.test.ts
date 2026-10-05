import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth as subKey, mem, setupDispatchTests } from "@/test/agent-dispatch-harness";
import type { AgencyApiAuthContext } from "@/lib/api/auth";

/**
 * `create_sub_account` on an agency key (AGENCY_AGENT_API_PLAN.md D3, A4a-1):
 * the new sub-account has both reach gates on, two gate audit changes, the
 * key's id, and the owner who minted the key as its member — never an
 * `apikey:` member. A per-key counter doc caps it at 10 a UTC day and a lock
 * doc returns the same sub-account for the same name within 10 minutes,
 * concurrent calls included. The chat path is pinned unchanged. Real
 * registry and dispatch over an in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-dispatch-harness")).adminMock());

const { dispatchAgentTool } = await import("./agent-dispatch");
const { getCapability } = await import("@/lib/ai-suite/capabilities");
const { TEMPLATE_PRESETS } = await import("@/lib/automations/template-presets");

setupDispatchTests();

const agencyKey: AgencyApiAuthContext = { ...subKey, level: "agency", subAccountId: null, keyLevel: "agency", keyId: "ak1" };
const create = (name: string) => dispatchAgentTool(agencyKey, "create_sub_account", { name });
const idOf = (r: unknown) => (r as { ref?: { id: string } }).ref?.id;
const newSubs = () => mem.list("subAccounts").filter((s) => s.id !== "sa1" && s.id !== "sa2");
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed("agencies/ag1/agencyMembers/owner1", {
    uid: "owner1", agencyId: "ag1", role: "owner", status: "active", email: "owner@example.com", displayName: "Owner One",
  });
  mem.seed("agencies/ag1/apiKeys/ak1", { agencyId: "ag1", subAccountId: null, createdByUid: "owner1", revokedAt: null });
});

describe("via an agency key", () => {
  it("both reach gates on, createdByKeyId stamped, the two gate changes audited", async () => {
    const r = await create("Smoke One");
    expect(r).toMatchObject({ ok: true, ref: { kind: "subAccount" } });
    const doc = mem.read(`subAccounts/${idOf(r)}`)!;
    expect(doc).toMatchObject({
      agencyId: "ag1", name: "Smoke One", createdByKeyId: "ak1", createdByUid: "owner1",
      apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true,
    });
    const audits = mem.list("auditEvents").filter((e) => e.action === "feature_gates.updated");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ subAccountId: idOf(r), agencyId: "ag1", actor: { type: "api_key", id: "ak1" } });
    expect(audits[0]!.changes).toEqual([
      { field: "apiAccessEnabledByAgency", before: false, after: true },
      { field: "agentApiEnabledByAgency", before: false, after: true },
    ]);
  });

  it("the member is the owner who minted the key, and no apikey: member exists anywhere", async () => {
    const id = idOf(await create("Smoke Two"));
    expect(mem.list(`subAccounts/${id}/subAccountMembers`)).toEqual([
      expect.objectContaining({ id: "owner1", uid: "owner1", role: "admin", status: "active", email: "owner@example.com", displayName: "Owner One" }),
    ]);
    expect(mem.read(`userMemberships/owner1/subAccounts/${id}`)).toMatchObject({ subAccountId: id, agencyId: "ag1", role: "admin" });
    expect(mem.all().filter((d) => d.path.includes("apikey:"))).toEqual([]);
    for (const t of mem.list("message_templates")) expect(t.createdByUid).toBe("owner1");
  });

  it("the 11th creation of a UTC day is refused and writes nothing", async () => {
    for (let i = 1; i <= 10; i++) expect(await create(`Smoke ${i}`)).toMatchObject({ ok: true });
    expect(mem.read(`agencies/ag1/apiKeys/ak1/creations/${today()}`)).toMatchObject({ count: 10 });
    const before = mem.all().length;
    expect(await create("Smoke 11")).toMatchObject({ ok: false, code: "invalid_request", httpStatus: 400 });
    expect(mem.all().length).toBe(before);
    expect(newSubs()).toHaveLength(10);
  });

  it("the same name within 10 minutes returns the same sub-account; once the lock expires it creates anew", async () => {
    const first = idOf(await create("Smoke Same"));
    const again = await create("Smoke Same");
    expect(idOf(again)).toBe(first);
    expect(newSubs()).toHaveLength(1);
    expect(mem.read(`agencies/ag1/apiKeys/ak1/creations/${today()}`)).toMatchObject({ count: 1 });
    const lock = mem.list("agencies/ag1/apiKeys/ak1/creations").find((d) => d.id.startsWith("name_"))!;
    mem.seed(`agencies/ag1/apiKeys/ak1/creations/${lock.id}`, { ...lock, expiresAt: new Date(Date.now() - 1) });
    expect(idOf(await create("Smoke Same"))).not.toBe(first);
    expect(newSubs()).toHaveLength(2);
  });

  it("two concurrent creates of one name produce one doc", async () => {
    const [a, b] = await Promise.all([create("Smoke Race"), create("Smoke Race")]);
    expect(idOf(a)).toBeDefined();
    expect(idOf(b)).toBe(idOf(a));
    expect(newSubs()).toHaveLength(1);
    expect(mem.list(`subAccounts/${idOf(a)}/subAccountMembers`)).toHaveLength(1);
  });
});

describe("via chat (the Agency Assistant)", () => {
  it("is unchanged: the person is the member, no reach gate on, no key stamp, no counter, no gate audit", async () => {
    const ctx = { uid: "owner1", email: "owner@example.com", displayName: "Owner One", agencyId: "ag1" };
    const res = await getCapability("create_sub_account")!.execute(ctx, { name: "Chat Co", slug: "", timezone: "UTC" });
    const id = res.ref!.id;
    const { createdAt, updatedAt, ...doc } = mem.read(`subAccounts/${id}`)!;
    expect(createdAt).toBeInstanceOf(Date);
    expect(updatedAt).toBeInstanceOf(Date);
    expect(doc).toEqual({
      id, agencyId: "ag1", accountNumber: 1000, name: "Chat Co", slug: id.slice(0, 8), status: "active", timezone: "UTC",
      createdByUid: "owner1", twilioConfig: null, resendConfig: null, emailDomainEnabledByAgency: false,
      outboundVoiceEnabledByAgency: false, whatsappEnabledByAgency: false, smsAgentEnabledByAgency: true,
      webChatEnabledByAgency: true, inboundVoiceEnabledByAgency: true, metaInboxEnabledByAgency: false,
      metaAgentEnabledByAgency: false, websiteEnabledByAgency: false, communityEnabledByAgency: false,
      getLeadsEnabledByAgency: false, prospectingEnabledByAgency: false, missedCallTextBackEnabledByAgency: false,
      labsEnabledByAgency: false, paymentsEnabledByAgency: false, stripeConnectionMeta: null,
      webinar1EnabledByAgency: false, googleEnabledByAgency: false, googleCalendarEnabledByAgency: false,
      reviewsAiEnabledByAgency: false, reviewsAutoReplyEnabledByAgency: false, agentApiEnabledByAgency: false,
      webinar1ConnectionMeta: null, aiSuiteEnabledByAgency: false, metaConfig: null, bookingConfig: null,
      sendWindow: null, bookingLink: null, replyToEmail: null, automationsPaused: false, accountContact: null,
    });
    expect(res.resultText).toBe("Created sub-account “Chat Co” (#1000). You'll find it under Agency → Sub-accounts.");
    expect(mem.list(`subAccounts/${id}/subAccountMembers`).map((m) => m.id)).toEqual(["owner1"]);
    expect(mem.read(`userMemberships/owner1/subAccounts/${id}`)).toMatchObject({ role: "admin", accountNumber: 1000 });
    expect(mem.list("message_templates").map((t) => [t.subAccountId, t.createdByUid])).toEqual(
      TEMPLATE_PRESETS.map(() => [id, "owner1"]),
    );
    expect(mem.all().filter((d) => d.path.includes("/creations/"))).toEqual([]);
    expect(mem.list("auditEvents")).toEqual([]);
  });
});
