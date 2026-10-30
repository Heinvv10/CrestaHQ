import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The lazy legacy migration (agent.ts maybeMigrateLegacy): a sub-account
 * that still has only `aiConfig/main` gets its profile + sms channel on the
 * first read, both or neither, in one transaction that re-reads the profile.
 * A read that went stale (another migration, a snapshot apply that migrates
 * in its own transaction (A4a-2), an operator's save since) therefore writes
 * nothing over what is there now.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { getAgentProfile, incrementChannelTokens, resolveAgent, upsertAgentProfile, upsertChannelConfig } = await import("./agent");
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

  it("keeps an sms channel doc already there (no profile yet)", async () => {
    mem.seed("subAccounts/sa1/aiAgent/sms", { enabled: true, contextMessageCount: 12 });
    expect(await getAgentProfile("sa1")).toMatchObject({ businessName: "Client One" });
    expect(mem.read("subAccounts/sa1/aiAgent/sms")).toEqual({ enabled: true, contextMessageCount: 12 });
  });

  it("does nothing once a profile exists", async () => {
    mem.seed("subAccounts/sa1/aiAgent/profile", { systemPrompt: "Mine." });
    expect((await getAgentProfile("sa1"))?.systemPrompt).toBe("Mine.");
    expect(mem.read("subAccounts/sa1/aiAgent/sms")).toBeUndefined();
  });
});

/** Park the first read of the legacy doc, after its snapshot was taken: the
 *  migration that made it then acts on a stale read once released. */
function parkFirstLegacyRead() {
  let entered!: () => void;
  const reached = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const orig = mem.db.doc.bind(mem.db);
  const spy = vi.spyOn(mem.db, "doc").mockImplementation((p: string) => {
    const ref = orig(p);
    if (p !== "subAccounts/sa1/aiConfig/main") return ref;
    return {
      ...ref,
      get: async () => {
        const snap = await ref.get();
        spy.mockRestore();
        entered();
        await gate;
        return snap;
      },
    };
  });
  return { reached, release };
}

describe("a migration acting on a stale read", () => {
  it("two lazy migrations: the parked one writes nothing more; both callers resolve profile and sms", async () => {
    const { reached, release } = parkFirstLegacyRead();
    const first = resolveAgent("sa1", "sms");
    await reached;
    const second = await resolveAgent("sa1", "sms");
    expect(second?.channel).toMatchObject({ contextMessageCount: 7 });
    const written = mem.read("subAccounts/sa1/aiAgent/profile");
    release();
    expect((await first)?.channel).toMatchObject({ contextMessageCount: 7 });
    expect(mem.read("subAccounts/sa1/aiAgent/profile")).toEqual(written);
  });

  it("another migrates and the operator switches SMS off: the parked one does not switch it back on", async () => {
    mem.seed("subAccounts/sa1/aiConfig/main", { ...LEGACY, enabled: true, modelOverride: "legacy/model", totalTokensUsed: 5 });
    const { reached, release } = parkFirstLegacyRead();
    const late = resolveAgent("sa1", "sms");
    await reached;
    await getAgentProfile("sa1"); // another read migrates fully
    await upsertChannelConfig("sa1", "sms", { enabled: false, modelOverride: null, totalTokensUsed: 99 });
    release();
    expect((await late)?.effective.enabled).toBe(false);
    expect(mem.read("subAccounts/sa1/aiAgent/sms")).toMatchObject({ enabled: false, modelOverride: null, totalTokensUsed: 99 });
    expect((await resolveAgent("sa1", "sms"))?.effective.enabled).toBe(false);
  });

  it("a snapshot apply commits meanwhile: the applied persona stays and is what the agent resolves", async () => {
    const { reached, release } = parkFirstLegacyRead();
    const migrating = getAgentProfile("sa1");
    await reached;
    const applied = await applySnapshot(mem.db as unknown as Firestore, payload, "sa1", { agencyId: "ag1", createdByUid: "owner1", snapshotId: "snap1" });
    expect(applied.aiProfileApplied).toBe(true);
    release();
    expect((await migrating)?.systemPrompt).toBe("Snapshot persona.");
    expect(mem.read("subAccounts/sa1/aiAgent/profile")).toMatchObject({ systemPrompt: "Snapshot persona.", businessName: "Client One" });
    expect((await resolveAgent("sa1", "sms"))?.effective.systemPrompt).toBe("Snapshot persona.");
  });
});

/** Park the first transaction after its body ran (its reads made, its writes
 *  queued) and before its commit: a write landing meanwhile must make it
 *  re-run, which only a doc read through the transaction can. */
function parkFirstCommit() {
  let entered!: () => void;
  const reached = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run = mem.db.runTransaction.bind(mem.db);
  const spy = vi.spyOn(mem.db, "runTransaction").mockImplementationOnce((fn) => {
    spy.mockRestore();
    return run(async (tx) => {
      const result = await fn(tx);
      entered();
      await gate;
      return result;
    });
  });
  return { reached, release };
}

describe("writes landing between a transaction's reads and its commit", () => {
  it("migration: another creates the profile and the operator sets the prompt; the parked one leaves both", async () => {
    // The operator edits only the profile here: an sms edit would conflict
    // on the sms read too and hide a profile read made outside the transaction.
    mem.seed("subAccounts/sa1/aiAgent/sms", { enabled: true, contextMessageCount: 12 });
    const { reached, release } = parkFirstCommit();
    const late = getAgentProfile("sa1");
    await reached;
    await getAgentProfile("sa1"); // another read migrates: the profile now exists
    await upsertAgentProfile("sa1", { systemPrompt: "Operator prompt." });
    release();
    expect((await late)?.systemPrompt).toBe("Operator prompt.");
    expect(mem.read("subAccounts/sa1/aiAgent/profile")).toMatchObject({ systemPrompt: "Operator prompt.", businessName: "Client One" });
    expect(mem.read("subAccounts/sa1/aiAgent/sms")).toEqual({ enabled: true, contextMessageCount: 12 });
  });

  it("migration: an sms channel doc written meanwhile is kept", async () => {
    // incrementChannelTokens writes the sms doc without migrating, so the
    // profile stays absent and only the sms read can see the write.
    const { reached, release } = parkFirstCommit();
    const late = getAgentProfile("sa1");
    await reached;
    await incrementChannelTokens("sa1", "sms", 5);
    release();
    expect((await late)?.businessName).toBe("Client One");
    expect(mem.read("subAccounts/sa1/aiAgent/sms")).toMatchObject({ totalTokensUsed: 5 });
    expect(mem.read("subAccounts/sa1/aiAgent/sms")?.contextMessageCount).toBeUndefined();
  });

  it("snapshot apply: a persona the operator saves meanwhile is kept", async () => {
    await mem.db.doc("subAccounts/sa1/aiConfig/main").delete(); // no legacy: only the profile read can see it
    const { reached, release } = parkFirstCommit();
    const applying = applySnapshot(mem.db as unknown as Firestore, payload, "sa1", { agencyId: "ag1", createdByUid: "owner1", snapshotId: "snap1" });
    await reached;
    await upsertAgentProfile("sa1", { systemPrompt: "Operator prompt." });
    release();
    expect((await applying).aiProfileApplied).toBe(false);
    expect(mem.read("subAccounts/sa1/aiAgent/profile")?.systemPrompt).toBe("Operator prompt.");
  });

  it("snapshot apply: an sms channel doc written meanwhile is kept", async () => {
    const { reached, release } = parkFirstCommit();
    const applying = applySnapshot(mem.db as unknown as Firestore, payload, "sa1", { agencyId: "ag1", createdByUid: "owner1", snapshotId: "snap1" });
    await reached;
    await incrementChannelTokens("sa1", "sms", 5);
    release();
    expect((await applying).aiProfileApplied).toBe(true);
    expect(mem.read("subAccounts/sa1/aiAgent/sms")).toMatchObject({ totalTokensUsed: 5 });
    expect(mem.read("subAccounts/sa1/aiAgent/sms")?.contextMessageCount).toBeUndefined();
    expect(mem.read("subAccounts/sa1/aiAgent/profile")).toMatchObject({ systemPrompt: "Snapshot persona.", businessName: "Client One" });
  });
});

describe("a migration that fails part-way", () => {
  it("leaves neither doc behind, and the next read migrates fully", async () => {
    const unavailable = () => Object.assign(new Error("14 UNAVAILABLE"), { code: 14 });
    // Fail the profile's write however the migration makes it: a create()
    // of its own, or the commit of the transaction it is part of.
    const orig = mem.db.doc.bind(mem.db);
    const docSpy = vi.spyOn(mem.db, "doc").mockImplementation((p: string) => {
      const ref = orig(p);
      return p === "subAccounts/sa1/aiAgent/profile" ? { ...ref, create: async () => Promise.reject(unavailable()) } : ref;
    });
    const run = mem.db.runTransaction.bind(mem.db);
    const txSpy = vi.spyOn(mem.db, "runTransaction").mockImplementation((fn) =>
      run(async (tx) => {
        await fn(tx);
        throw unavailable();
      })
    );
    await expect(getAgentProfile("sa1")).rejects.toThrow(/UNAVAILABLE/);
    docSpy.mockRestore();
    txSpy.mockRestore();
    expect(mem.read("subAccounts/sa1/aiAgent/profile")).toBeUndefined();
    expect(mem.read("subAccounts/sa1/aiAgent/sms")).toBeUndefined();
    expect((await resolveAgent("sa1", "sms"))?.profile).toMatchObject({ businessName: "Client One" });
    expect(mem.read("subAccounts/sa1/aiAgent/sms")).toMatchObject({ contextMessageCount: 7 });
  });
});
