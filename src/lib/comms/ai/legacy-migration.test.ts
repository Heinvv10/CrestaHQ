import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The lazy legacy migration (agent.ts maybeMigrateLegacy): a sub-account
 * that still has only `aiConfig/main` gets its profile + sms channel on the
 * first read. It creates the profile, never overwrites one: a snapshot apply
 * (A4a-2) that migrates and merges in its own transaction can commit between
 * this migration's read and its write, and the migration must then leave
 * that profile alone.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { getAgentProfile, resolveAgent } = await import("./agent");
const { applySnapshot } = await import("@/lib/snapshots/apply");

const LEGACY = {
  systemPrompt: "", enabled: false, escalationNotifyEmail: "ops@client.io", businessName: "Client One", contextMessageCount: 7,
};
const PERSONA = { systemPrompt: "Snapshot persona.", hoursStart: 8, hoursEnd: 17, timezone: "UTC", escalationKeywords: [] };
const payload = { forms: [], messageTemplates: [], products: [], workflows: [], aiProfile: PERSONA };

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("subAccounts/sa1/aiConfig/main", LEGACY);
});

describe("the lazy migration on its own", () => {
  it("splits aiConfig/main into the profile and the sms channel, as before", async () => {
    const profile = await getAgentProfile("sa1");
    expect(profile).toMatchObject({ systemPrompt: "", businessName: "Client One", escalationNotifyEmail: "ops@client.io", hoursStart: 9, hoursEnd: 17 });
    expect(mem.read("subAccounts/sa1/aiAgent/sms")).toMatchObject({ enabled: false, contextMessageCount: 7 });
    expect(mem.read("subAccounts/sa1/aiConfig/main")).toMatchObject(LEGACY);
  });

  it("does nothing once a profile exists", async () => {
    mem.seed("subAccounts/sa1/aiAgent/profile", { systemPrompt: "Mine." });
    expect((await getAgentProfile("sa1"))?.systemPrompt).toBe("Mine.");
    expect(mem.read("subAccounts/sa1/aiAgent/sms")).toBeUndefined();
  });
});

describe("a snapshot apply committing between the migration's read and its write", () => {
  it("the migration loses: the applied persona stays and is what the agent resolves", async () => {
    // Hold the migration's writes until the apply has committed.
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = mem.db.doc.bind(mem.db);
    const spy = vi.spyOn(mem.db, "doc").mockImplementation((p: string) => {
      const ref = orig(p);
      if (!p.startsWith("subAccounts/sa1/aiAgent/")) return ref;
      const held = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A) => (entered(), await gate, fn(...a));
      return { ...ref, set: held(ref.set), create: held(ref.create) };
    });
    const migrating = getAgentProfile("sa1");
    await reached;
    spy.mockRestore();
    const applied = await applySnapshot(mem.db as unknown as Firestore, payload, "sa1", { agencyId: "ag1", createdByUid: "owner1", snapshotId: "snap1" });
    expect(applied.aiProfileApplied).toBe(true);
    release();
    // The caller reads the profile that now exists, not the migration's copy.
    expect((await migrating)?.systemPrompt).toBe("Snapshot persona.");
    expect(mem.read("subAccounts/sa1/aiAgent/profile")).toMatchObject({ systemPrompt: "Snapshot persona.", businessName: "Client One" });
    expect((await resolveAgent("sa1", "sms"))?.effective.systemPrompt).toBe("Snapshot persona.");
  });
});
