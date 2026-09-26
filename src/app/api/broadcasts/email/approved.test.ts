import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An API agent's broadcast, as approved (`BroadcastDoc.approved`): the
 * fan-out queues no more recipients than a person saw, and the step sends
 * only the template they reviewed. A person's own broadcast is unchanged.
 */

const publishCallback = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ messageId: "q" })));
const sendEmail = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ id: "m1" })));
vi.mock("@/lib/automations/qstash", () => ({ qstashIsConfigured: () => true, verifyQStashSignature: async () => true, publishCallback }));
vi.mock("@/lib/comms/resend", () => ({ emailIsConfigured: () => true, tenantFrom: () => "s@t.test", sendEmail }));
vi.mock("@/lib/server/usage-meter", () => ({ checkQuota: async () => ({ allowed: true }) }));
vi.mock("@/lib/automations/unsubscribe-token", () => ({ buildUnsubscribeUrl: (id: string) => `https://app.test/u/${id}` }));
const mem = await vi.hoisted(async () => (await import("@/test/memory-firestore")).createMemoryFirestore());
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { POST: fanout } = await import("./fanout/route");
const { POST: step } = await import("./step/route");
const { templateFingerprint } = await import("@/lib/broadcasts/approved");
const TEMPLATE = { subAccountId: "sa1", agencyId: "ag1", type: "email", name: "Promo", subject: "Hi", body: "Half price. {{unsubscribeLink}}" };
const post = (fn: (r: Request) => Promise<Response>, body: object) =>
  fn(new Request("https://app.test/x", { method: "POST", headers: { "upstash-signature": "sig" }, body: JSON.stringify(body) }));
const broadcast = (approved: object | null) =>
  mem.seed("broadcasts/b1", {
    id: "b1", subAccountId: "sa1", agencyId: "ag1", templateId: "t1", templateName: "Promo", audienceFilter: { kind: "all" }, status: "queued",
    totals: { audienceSize: 0, queued: 0, sent: 0, skipped: 0, failed: 0 }, fanoutDone: false, ...(approved ? { approved } : {}),
  });

beforeEach(() => {
  mem.clear();
  publishCallback.mockClear();
  sendEmail.mockClear();
  mem.seed("subAccounts/sa1", { name: "Acme", broadcastsEnabledByAgency: true });
  mem.seed("agencies/ag1", {});
  mem.seed("message_templates/t1", TEMPLATE);
  for (const id of ["c1", "c2", "c3"]) mem.seed(`contacts/${id}`, { subAccountId: "sa1", agencyId: "ag1", name: id, email: `${id}@x.io`, phone: "" });
});

describe("edited since approval", () => {
  it("an edit in the same millisecond as the proposal counts (two server clocks can tie)", async () => {
    const { editedByAgentSinceApproval } = await import("@/lib/broadcasts/approved");
    const at = new Date("2030-01-01T00:00:00.000Z");
    expect(editedByAgentSinceApproval({ approved: { templateFingerprint: "f", audienceCap: 1, at } }, { lastAgentEditAt: new Date(at.getTime()) })).toBe(true);
    expect(editedByAgentSinceApproval({ approved: { templateFingerprint: "f", audienceCap: 1, at } }, { lastAgentEditAt: new Date(at.getTime() - 1) })).toBe(false);
  });
});

describe("the fan-out", () => {
  it("queues only the approved number; the rest are skipped as over the approved audience", async () => {
    broadcast({ templateFingerprint: templateFingerprint(TEMPLATE as never), audienceCap: 2 });
    await post(fanout, { broadcastId: "b1", cursor: null, slot: 0 });
    const rows = mem.list("broadcasts/b1/sends");
    expect(rows.filter((r) => r.status === "queued")).toHaveLength(2);
    expect(rows.filter((r) => r.skippedReason === "over_approved_audience")).toHaveLength(1);
    expect(publishCallback).toHaveBeenCalledTimes(2);
  });

  it("recipients already sent or failed count against the approved number", async () => {
    broadcast({ templateFingerprint: templateFingerprint(TEMPLATE as never), audienceCap: 3 });
    mem.seed("broadcasts/b1", { ...mem.read("broadcasts/b1")!, totals: { audienceSize: 2, queued: 0, sent: 1, skipped: 0, failed: 1 } });
    await post(fanout, { broadcastId: "b1", cursor: null, slot: 0 });
    expect(mem.list("broadcasts/b1/sends").filter((r) => r.status === "queued")).toHaveLength(1);
  });

  it("a contact an API agent edited after approval is skipped, the others queued", async () => {
    broadcast({ templateFingerprint: templateFingerprint(TEMPLATE as never), audienceCap: 3, at: new Date(Date.now() - 60_000) });
    mem.seed("contacts/c2", { ...mem.read("contacts/c2")!, lastAgentEditAt: new Date(), lastAgentEditKey: "abcd1234" });
    mem.seed("contacts/c3", { ...mem.read("contacts/c3")!, lastAgentEditAt: new Date(Date.now() - 120_000) });
    await post(fanout, { broadcastId: "b1", cursor: null, slot: 0 });
    const rows = mem.list("broadcasts/b1/sends");
    expect(rows.find((r) => r.id === "c2")).toMatchObject({ status: "skipped", skippedReason: "edited_by_agent_after_approval" });
    expect(rows.filter((r) => r.status === "queued").map((r) => r.id).sort()).toEqual(["c1", "c3"]);
  });

  it("a person's broadcast queues everyone, as before", async () => {
    broadcast(null);
    await post(fanout, { broadcastId: "b1", cursor: null, slot: 0 });
    expect(mem.list("broadcasts/b1/sends").filter((r) => r.status === "queued")).toHaveLength(3);
  });
});

describe("the step", () => {
  const queued = () => {
    mem.seed("broadcasts/b1", { ...mem.read("broadcasts/b1")!, status: "sending", totals: { queued: 1 } });
    mem.seed("broadcasts/b1/sends/c1", { status: "queued" });
  };

  it("the reviewed template -> sent", async () => {
    broadcast({ templateFingerprint: templateFingerprint(TEMPLATE as never), audienceCap: 3 });
    queued();
    await post(step, { broadcastId: "b1", contactId: "c1" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a contact an API agent edited after approval (a queued row) -> skipped at send, not sent", async () => {
    broadcast({ templateFingerprint: templateFingerprint(TEMPLATE as never), audienceCap: 3, at: new Date(Date.now() - 60_000) });
    queued();
    mem.seed("contacts/c1", { ...mem.read("contacts/c1")!, name: "Evil {{link}}", lastAgentEditAt: new Date() });
    await post(step, { broadcastId: "b1", contactId: "c1" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mem.read("broadcasts/b1/sends/c1")).toMatchObject({ status: "skipped", skippedReason: "edited_by_agent_after_approval" });
  });

  it("a template edited since approval -> not sent, the row failed", async () => {
    broadcast({ templateFingerprint: templateFingerprint(TEMPLATE as never), audienceCap: 3 });
    queued();
    mem.seed("message_templates/t1", { ...TEMPLATE, body: "Full price now. {{unsubscribeLink}}" });
    await post(step, { broadcastId: "b1", contactId: "c1" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mem.read("broadcasts/b1/sends/c1")).toMatchObject({ status: "failed", error: "The template changed after this broadcast was approved; not sent." });
  });
});
