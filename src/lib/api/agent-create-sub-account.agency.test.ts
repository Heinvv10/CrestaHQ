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

describe("the audit trail of a key's create", () => {
  const agentWrites = () => mem.list("auditEvents").filter((e) => e.action === "agent.write");

  it("a normal create files exactly one agent.write, under the sub-account it created", async () => {
    const id = idOf(await create("Smoke Audit"));
    expect(agentWrites()).toEqual([expect.objectContaining({ subAccountId: id, actor: { type: "api_key", id: "ak1" } })]);
  });

  it("a stray subAccountId (the tool takes none) → 400, no agent.call or agent.write anywhere, nothing created", async () => {
    mem.seed("subAccounts/other", { agencyId: "ag1", name: "Other", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
    const r = await dispatchAgentTool(agencyKey, "create_sub_account", { name: "Smoke Stray", subAccountId: "other" });
    expect(r).toMatchObject({ ok: false, code: "invalid_args", httpStatus: 400 });
    expect(mem.all().filter((d) => d.path.includes("/agentCalls/"))).toEqual([]);
    expect(agentWrites()).toEqual([]);
    expect(newSubs().map((s) => s.id)).toEqual(["other"]);
  });
});

describe("the key's standing, read in the creating transaction", () => {
  it.each([
    ["the key is revoked", () => mem.seed("agencies/ag1/apiKeys/ak1", { agencyId: "ag1", createdByUid: "owner1", revokedAt: new Date() })],
    ["the minter is demoted", () => mem.seed("agencies/ag1/agencyMembers/owner1", { uid: "owner1", role: "admin", status: "active" })],
    ["the minter is suspended", () => mem.seed("agencies/ag1/agencyMembers/owner1", { uid: "owner1", role: "owner", status: "suspended" })],
  ])("%s → refused, nothing created", async (_label, arrange) => {
    arrange();
    expect(await create("Smoke Standing")).toMatchObject({ ok: false, code: "invalid_request", httpStatus: 400 });
    expect(newSubs()).toEqual([]);
    expect(mem.all().filter((d) => d.path.includes("/creations/"))).toEqual([]);
  });
});

describe("the key's standing is read INSIDE the creating transaction", () => {
  it.each([
    ["a key revoke", "agencies/ag1/apiKeys/ak1", { agencyId: "ag1", createdByUid: "owner1", revokedAt: new Date() }],
    ["a minter demotion", "agencies/ag1/agencyMembers/owner1", { uid: "owner1", agencyId: "ag1", role: "admin", status: "active" }],
  ])("%s committing between an attempt's reads and its commit → the retry refuses, nothing created", async (_label, path, doc) => {
    // Firestore retries a transaction whose reads changed before it committed:
    // the in-memory fake does the same, so the change lands mid-attempt here.
    const real = mem.db.runTransaction.bind(mem.db);
    const spy = vi.spyOn(mem.db, "runTransaction").mockImplementationOnce((fn) =>
      real(async (tx) => {
        const out = await fn(tx);
        mem.seed(path, doc);
        return out;
      }));
    try {
      expect(await create("Smoke Raced")).toMatchObject({ ok: false, code: "invalid_request", httpStatus: 400 });
    } finally {
      spy.mockRestore();
    }
    expect(newSubs()).toEqual([]);
    expect(mem.all().filter((d) => d.path.includes("/creations/"))).toEqual([]);
  });
});

describe("the name lock", () => {
  it("is checked before the cap: on a capped day a repeat within 10 minutes returns the existing id", async () => {
    const ids: Array<string | undefined> = [];
    for (let i = 1; i <= 10; i++) ids.push(idOf(await create(`Smoke ${i}`)));
    expect(await create("Smoke 11")).toMatchObject({ ok: false });
    expect(await create("Smoke 3")).toMatchObject({ ok: true, ref: { id: ids[2] } });
    expect(newSubs()).toHaveLength(10);
  });

  it("pointing at a sub-account deleted since → a new one is created and the lock moves to it", async () => {
    const first = idOf(await create("Smoke Gone"))!;
    await mem.db.doc(`subAccounts/${first}`).delete();
    const second = idOf(await create("Smoke Gone"));
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(mem.read(`subAccounts/${second}`)).toMatchObject({ name: "Smoke Gone" });
    expect(idOf(await create("Smoke Gone"))).toBe(second);
    expect(mem.read(`agencies/ag1/apiKeys/ak1/creations/${today()}`)).toMatchObject({ count: 2 });
  });

  it.each([
    ["case", "Acme", "acme"],
    ["inner whitespace", "Acme Ltd", "Acme  Ltd"],
    ["a zero-width space", "Acme", "Acme\u200B"],
    ["a zero-width joiner inside", "Acme Ltd", "Acme\u200D Ltd"],
    ["a byte-order mark", "Acme", "\uFEFFAcme"],
    ["a compatibility form (NFKC)", "Acme", "\uFF21cme"],
    ["a left-to-right mark", "Acme", "Acme\u200E"],
    ["a word joiner inside", "Acme Ltd", "Acme\u2060 Ltd"],
    ["a soft hyphen inside", "Acme", "Ac\u00ADme"],
  ])("normalises %s: the same sub-account, stored under the name first given", async (_label, a, b) => {
    const first = idOf(await create(a));
    expect(idOf(await create(b))).toBe(first);
    expect(newSubs()).toHaveLength(1);
    expect(mem.read(`subAccounts/${first}`)?.name).toBe(a);
  });

  it("a lock hit replies with the stored name, not the one just sent", async () => {
    await create("Acme");
    const again = (await create("acme")) as { resultText: string };
    expect(again.resultText).toContain("“Acme”");
    expect(again.resultText).not.toContain("“acme”");
  });

  it("a lock hit writes nothing, so it files no second agent.write", async () => {
    await create("Smoke Once");
    await create("Smoke Once");
    expect(mem.list("auditEvents").filter((e) => e.action === "agent.write")).toHaveLength(1);
  });

  it.each([
    ["only zero-width characters", "\u200B\u200C\u2060"],
    ["only format characters and spaces", "\u200E \u00AD"],
    ["a Hangul filler alone", "\u3164"],
    ["a halfwidth Hangul filler alone", "\uFFA0"],
    ["a Hangul choseong filler alone", "\u115F"],
    ["a Hangul jungseong filler alone", "\u1160"],
    ["the Braille blank alone", "\u2800"],
    ["a variation selector alone", "\uFE0F"],
    ["a combining grapheme joiner alone", "\u034F"],
  ])("a name that is %s → refused, nothing created", async (_label, name) => {
    expect(await create(name)).toMatchObject({ ok: false, code: "invalid_request", httpStatus: 400 });
    expect(newSubs()).toEqual([]);
    expect(mem.all().filter((d) => d.path.includes("/creations/"))).toEqual([]);
  });

  it.each(["7 Eleven", "Caf\u00E9", "42"])("an ordinary name (%s) still creates", async (name) => {
    expect(await create(name)).toMatchObject({ ok: true, ref: { kind: "subAccount" } });
    expect(newSubs().map((s) => s.name)).toEqual([name]);
  });

  it("different names still create different sub-accounts", async () => {
    expect(idOf(await create("Acme"))).not.toBe(idOf(await create("Acme Ltd")));
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
