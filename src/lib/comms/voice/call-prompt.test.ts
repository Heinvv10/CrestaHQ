import { beforeEach, describe, expect, it, vi } from "vitest";

/** voiceCallPrompt's outbound contact: the call's own contact, by id, in this sub-account only. */

const blocks = vi.hoisted(() => [] as Array<string | null>);
vi.mock("@/lib/comms/ai/prompt", () => ({
  buildSystemPrompt: (a: { contactContextBlock: string | null }) => (blocks.push(a.contactContextBlock), "PROMPT"),
}));
const mem = await vi.hoisted(async () => (await import("@/test/memory-firestore")).createMemoryFirestore());
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { voiceCallPrompt } = await import("./call-prompt");
const agent = { channel: { voice: {} }, effective: { systemPrompt: "Be kind." } } as never;
const run = (contactId: string) => voiceCallPrompt({ subAccountId: "sa1", agent, subAccount: { name: "Acme" } as never, callerPhone: "+27821111111", outbound: true, contactId });

beforeEach(() => {
  mem.clear();
  blocks.length = 0;
  mem.seed("contacts/c1", { subAccountId: "sa1", name: "Ann Smith", phone: "+27821111111" });
  mem.seed("contacts/c1/sub/y", { subAccountId: "sa1", name: "Sub Doc" });
});

describe("voiceCallPrompt, outbound", () => {
  it("greets the called contact", async () => {
    expect((await run("c1")).contact?.name).toBe("Ann Smith");
    expect(blocks[0]).toContain("Ann");
  });

  it("a contact id that is a path greets nobody (never reads the subcollection doc)", async () => {
    expect((await run("c1/sub/y")).contact).toBeNull();
    expect(blocks[0]).toBeNull();
  });
});
