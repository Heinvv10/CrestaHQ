import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { applySnapshot } from "./apply";
import { planSnapshotApply } from "./apply-plan";
import type { SnapshotPayload } from "@/types/snapshots";

/**
 * What applySnapshot leaves of the target's own data (A4a-2 fix round 1):
 *   - a profile that exists with a blank prompt keeps every field the
 *     operator set; only the persona fields a snapshot carries arrive;
 *   - one custom-field key gets one definition, even when two applies run
 *     at once or one payload names the key twice.
 */

const mem = createMemoryFirestore();
const db = mem.db as unknown as Firestore;
const scope = (snapshotId: string) => ({ agencyId: "ag1", createdByUid: "owner1", snapshotId });
const PERSONA = { systemPrompt: "You are the snapshot's agent.", hoursStart: 7, hoursEnd: 19, timezone: "Africa/Johannesburg", escalationKeywords: ["manager"] };

const payload = (fields: Array<[string, string]> = [], aiProfile: SnapshotPayload["aiProfile"] = null): SnapshotPayload => ({
  forms: [],
  messageTemplates: [],
  products: [],
  workflows: [],
  customFields: fields.map(([sourceId, key]) => ({ sourceId, entity: "contact", key, label: key })) as unknown as SnapshotPayload["customFields"],
  aiProfile,
});
const definitions = (key: string) => mem.list("subAccounts/sa_dst/customFields").filter((f) => f.key === key);

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa_dst", { agencyId: "ag1" });
});

describe("a profile with a blank prompt", () => {
  it("keeps the target's own fields; only the persona fields arrive", async () => {
    const fetched = new Date("2026-09-01T00:00:00Z");
    mem.seed("subAccounts/sa_dst/aiAgent/profile", {
      systemPrompt: "  ", businessName: "Target Co", escalationNotifyEmail: "ops@target.example",
      websiteUrl: "https://target.example", websiteKb: "# Target", websiteKbFetchedAt: fetched,
      hoursStart: 9, createdByUid: "operator1", operatorNote: "kept",
    });
    const r = await applySnapshot(db, payload([], PERSONA), "sa_dst", scope("snap1"));
    expect(r.aiProfileApplied).toBe(true);
    expect(mem.read("subAccounts/sa_dst/aiAgent/profile")).toMatchObject({
      ...PERSONA,
      businessName: "Target Co", escalationNotifyEmail: "ops@target.example",
      websiteUrl: "https://target.example", websiteKb: "# Target", websiteKbFetchedAt: fetched,
      createdByUid: "operator1", operatorNote: "kept",
    });
  });

  it("a hand-built persona carrying source identity cannot write it over the target's", async () => {
    mem.seed("subAccounts/sa_dst/aiAgent/profile", { systemPrompt: "", businessName: "Target Co", escalationNotifyEmail: "ops@target.example" });
    const smuggled = { ...PERSONA, businessName: "Source Co", escalationNotifyEmail: "src@source.example" } as SnapshotPayload["aiProfile"];
    await applySnapshot(db, payload([], smuggled), "sa_dst", scope("snap1"));
    expect(mem.read("subAccounts/sa_dst/aiAgent/profile")).toMatchObject({ businessName: "Target Co", escalationNotifyEmail: "ops@target.example" });
  });

  it("no profile at all: the full persona doc, re-blanked, as before", async () => {
    await applySnapshot(db, payload([], PERSONA), "sa_dst", scope("snap1"));
    expect(mem.read("subAccounts/sa_dst/aiAgent/profile")).toMatchObject({
      ...PERSONA, businessName: "", escalationNotifyEmail: null, websiteUrl: null, websiteKb: null, createdByUid: "owner1",
    });
  });
});

describe("an unmigrated legacy persona (aiConfig/main, no profile)", () => {
  it("a legacy prompt counts as set: kept, nothing written, the plan says kept", async () => {
    mem.seed("subAccounts/sa_dst/aiConfig/main", { systemPrompt: "Legacy persona.", enabled: true });
    const plan = await planSnapshotApply(db, payload([], PERSONA), "sa_dst", "snap1");
    const r = await applySnapshot(db, payload([], PERSONA), "sa_dst", scope("snap1"));
    expect([plan.persona, plan.replyingChannels, r.aiProfileApplied]).toEqual(["kept", [], false]);
    expect(mem.read("subAccounts/sa_dst/aiAgent/profile")).toBeUndefined();
  });

  it("a legacy doc with a blank prompt is migrated first, then merged: its own fields and SMS config stay", async () => {
    mem.seed("subAccounts/sa_dst/aiConfig/main", {
      systemPrompt: "", enabled: true, escalationNotifyEmail: "ops@client.io", businessName: "Client One", contextMessageCount: 7,
    });
    const plan = await planSnapshotApply(db, payload([], PERSONA), "sa_dst", "snap1");
    const r = await applySnapshot(db, payload([], PERSONA), "sa_dst", scope("snap1"));
    expect([plan.persona, plan.replyingChannels, r.aiProfileApplied]).toEqual(["written", ["sms"], true]);
    expect(mem.read("subAccounts/sa_dst/aiAgent/profile")).toMatchObject({
      ...PERSONA, escalationNotifyEmail: "ops@client.io", businessName: "Client One",
    });
    expect(mem.read("subAccounts/sa_dst/aiAgent/sms")).toMatchObject({ enabled: true, contextMessageCount: 7 });
  });

  it("a profile that exists (blank prompt) wins over a legacy doc, even one with a prompt: written", async () => {
    mem.seed("subAccounts/sa_dst/aiAgent/profile", { systemPrompt: "", businessName: "Target Co" });
    mem.seed("subAccounts/sa_dst/aiConfig/main", { systemPrompt: "Legacy persona.", enabled: true });
    const plan = await planSnapshotApply(db, payload([], PERSONA), "sa_dst", "snap1");
    const r = await applySnapshot(db, payload([], PERSONA), "sa_dst", scope("snap1"));
    expect([plan.persona, r.aiProfileApplied]).toEqual(["written", true]);
    expect(mem.read("subAccounts/sa_dst/aiAgent/profile")).toMatchObject({ systemPrompt: PERSONA.systemPrompt, businessName: "Target Co" });
  });
});

describe("the AI's hours a written persona lands with", () => {
  const NO_HOURS = { systemPrompt: "P.", escalationKeywords: [] } as unknown as SnapshotPayload["aiProfile"];
  it.each([
    ["the snapshot's, when it carries them", PERSONA, undefined, { hoursStart: 7, hoursEnd: 19, timezone: "Africa/Johannesburg", from: "snapshot" }],
    ["the target's own, kept, when it carries none", NO_HOURS, { systemPrompt: "", hoursStart: 6, hoursEnd: 20, timezone: "Europe/London" }, { hoursStart: 6, hoursEnd: 20, timezone: "Europe/London", from: "target" }],
    ["the defaults on a fresh profile when it carries none", NO_HOURS, undefined, { hoursStart: 0, hoursEnd: 0, timezone: "Australia/Sydney", from: "default" }],
    ["the defaults where neither the snapshot nor the profile has them", NO_HOURS, { systemPrompt: "" }, { hoursStart: 0, hoursEnd: 0, timezone: "Australia/Sydney", from: "default" }],
    ["per field: the snapshot's, else the profile's, else the default", { systemPrompt: "P.", hoursStart: 7 } as unknown as SnapshotPayload["aiProfile"], { systemPrompt: "", timezone: "Europe/London" }, { hoursStart: 7, hoursEnd: 0, timezone: "Europe/London", from: "mixed" }],
  ])("%s", async (_label, persona, existing, hours) => {
    if (existing) mem.seed("subAccounts/sa_dst/aiAgent/profile", existing);
    expect((await planSnapshotApply(db, payload([], persona), "sa_dst", "snap1")).aiHours).toEqual(hours);
    await applySnapshot(db, payload([], persona), "sa_dst", scope("snap1"));
    const { from: _from, ...landed } = hours;
    expect(mem.read("subAccounts/sa_dst/aiAgent/profile")).toMatchObject(landed);
  });
});

describe("a legacy doc and an sms channel doc", () => {
  it.each([
    ["legacy on, the sms doc off: the sms doc decides, and is kept", true, false, []],
    ["legacy off, the sms doc on: the sms doc decides, sms named once", false, true, ["sms"]],
    ["both on: sms named once", true, true, ["sms"]],
  ])("%s", async (_label, legacyOn, smsOn, channels) => {
    mem.seed("subAccounts/sa_dst/aiConfig/main", { systemPrompt: "", enabled: legacyOn, contextMessageCount: 3 });
    mem.seed("subAccounts/sa_dst/aiAgent/sms", { enabled: smsOn, contextMessageCount: 12 });
    expect((await planSnapshotApply(db, payload([], PERSONA), "sa_dst", "snap1")).replyingChannels).toEqual(channels);
    expect((await applySnapshot(db, payload([], PERSONA), "sa_dst", scope("snap1"))).aiProfileApplied).toBe(true);
    expect(mem.read("subAccounts/sa_dst/aiAgent/sms")).toMatchObject({ enabled: smsOn, contextMessageCount: 12 });
  });

  it("no sms doc: the legacy doc's enabled decides, and the migration writes it", async () => {
    mem.seed("subAccounts/sa_dst/aiConfig/main", { systemPrompt: "", enabled: true, contextMessageCount: 3 });
    expect((await planSnapshotApply(db, payload([], PERSONA), "sa_dst", "snap1")).replyingChannels).toEqual(["sms"]);
    await applySnapshot(db, payload([], PERSONA), "sa_dst", scope("snap1"));
    expect(mem.read("subAccounts/sa_dst/aiAgent/sms")).toMatchObject({ enabled: true, contextMessageCount: 3 });
  });
});

describe("one custom-field key, one definition", () => {
  it("two applies at once sharing a key → exactly one definition, one created and one skipped", async () => {
    const [a, b] = await Promise.all([
      applySnapshot(db, payload([["cfA", "plan"]]), "sa_dst", scope("snapA")),
      applySnapshot(db, payload([["cfB", "plan"]]), "sa_dst", scope("snapB")),
    ]);
    expect(definitions("plan")).toHaveLength(1);
    expect([a.customFieldsCreated + b.customFieldsCreated, a.customFieldsSkipped + b.customFieldsSkipped]).toEqual([1, 1]);
  });

  it("a payload naming one key twice → one definition; the plan says the same", async () => {
    const twice = payload([["cf1", "plan"], ["cf2", "plan"], ["cf3", "other"]]);
    const plan = await planSnapshotApply(db, twice, "sa_dst", "snap1");
    const r = await applySnapshot(db, twice, "sa_dst", scope("snap1"));
    expect(definitions("plan")).toHaveLength(1);
    expect([r.customFieldsCreated, r.customFieldsSkipped]).toEqual([2, 1]);
    expect([plan.create.customFields, plan.skip.customFields]).toEqual([2, 1]);
  });

  it("a retry and a re-apply of the same snapshot stay single", async () => {
    await applySnapshot(db, payload([["cf1", "plan"]]), "sa_dst", scope("snap1"));
    const again = await applySnapshot(db, payload([["cf1", "plan"]]), "sa_dst", scope("snap1"));
    expect([again.customFieldsCreated, again.customFieldsSkipped]).toEqual([0, 1]);
    expect(definitions("plan")).toHaveLength(1);
  });
});
