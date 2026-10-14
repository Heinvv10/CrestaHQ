import { beforeEach, describe, expect, it, vi } from "vitest";
import { ask, doConfirm, mem, seedTenants } from "@/test/chat-route-harness";

/**
 * The saved chat thread never brings back a confirmable card that shows
 * less than Confirm does: a pending proposal whose card text exceeds the
 * stored cap is kept as failed with no args (on write, and on read for
 * threads stored before), so after a refresh it has no Confirm button and
 * the confirm route refuses its args. A short card restores and confirms
 * as before.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/chat-route-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/chat-route-harness")).tenancyMock());
vi.mock("@/lib/ai-suite/model", async () => (await import("@/test/chat-route-harness")).modelMock());
vi.mock("@/lib/ai-suite/usage", () => ({ recordAiSuiteUsage: async () => undefined }));
vi.mock("@/lib/ai-suite/audit", () => ({ recordAiSuiteAction: async () => undefined }));

const { GET, PUT } = await import("./route");

const G1 = "subAccounts/sa1/communityGroups/g1";
const LESSON_ARGS = { groupId: "g1", courseId: "co1", courseTitle: "Basics", title: "Welcome" };
const THREAD = "subAccounts/sa1/aiSuiteThreads/u1";
const lessons = () => mem.list(`${G1}/courses/co1/lessons`);
const storedMessage = () => (mem.read(THREAD)!.messages as unknown[])[0];

type Proposal = { id: string; capability: string; args: Record<string, unknown>; summary: string; status: string; resultText?: string | null };

/** The card the chat route offers, saved as the client saves it, then read back as a refresh does. */
async function saveAndRestore(args: Record<string, unknown>): Promise<{ offered: Proposal; restored: Proposal }> {
  const body = await (await ask("add_lesson", args)).json();
  const offered = { ...body.proposal, status: "pending" } as Proposal;
  const message = { role: "assistant", kind: "proposal", ...offered };
  const put = await PUT(new Request("http://x/api/ai-suite/thread", { method: "PUT", body: JSON.stringify({ level: "sub-account", subAccountId: "sa1", messages: [message] }) }));
  expect(put.status).toBe(200);
  const got = await (await GET(new Request("http://x/api/ai-suite/thread?level=sub-account&subAccountId=sa1"))).json();
  return { offered, restored: got.messages[0] as Proposal };
}

beforeEach(() => {
  seedTenants({ communityEnabledByAgency: true });
  mem.seed(G1, { name: "Fibre Club", slug: "fibre-club", status: "published", subAccountId: "sa1", agencyId: "ag1" });
  mem.seed(`${G1}/courses/co1`, { title: "Basics", published: true, order: 0, subAccountId: "sa1", agencyId: "ag1", groupId: "g1" });
});

describe("restoring a pending proposal", () => {
  it("a ~19.8k-character add_lesson card restores as failed with no args; confirming what came back publishes nothing", async () => {
    const { offered, restored } = await saveAndRestore({ ...LESSON_ARGS, text: "Lesson body. ".repeat(1500) });
    expect(offered.summary.length).toBeGreaterThan(19_000);
    expect(restored).toMatchObject({ status: "failed", args: {}, resultText: expect.stringContaining("too long to keep across a refresh") });
    expect(restored.summary.length).toBe(6000);
    // Stored that way too, not only read back that way.
    expect(storedMessage()).toMatchObject({ status: "failed", args: {} });
    expect((await doConfirm(restored.capability, restored.args)).status).toBe(400);
    expect(lessons()).toEqual([]);
  });

  it("a short card restores pending with its args, and confirms as before", async () => {
    const { offered, restored } = await saveAndRestore({ ...LESSON_ARGS, text: "Short body." });
    expect(restored).toMatchObject({ status: "pending", args: offered.args, summary: offered.summary });
    expect((await doConfirm(restored.capability, restored.args)).status).toBe(200);
    expect(lessons()).toHaveLength(1);
  });

  it("a thread stored before the fix (summary already cut to 6000, still pending) is not confirmable on read", async () => {
    mem.seed(THREAD, {
      level: "sub-account",
      messages: [{ role: "assistant", kind: "proposal", id: "p1", capability: "add_lesson", args: { ...LESSON_ARGS, text: "x".repeat(19_000) }, summary: "y".repeat(6000), status: "pending", resultText: null }],
    });
    const got = await (await GET(new Request("http://x/api/ai-suite/thread?level=sub-account&subAccountId=sa1"))).json();
    expect(got.messages[0]).toMatchObject({ status: "failed", args: {} });
  });

  it("a settled card that was cut stays as it was (nothing to confirm)", async () => {
    const message = { role: "assistant", kind: "proposal", id: "p2", capability: "add_lesson", args: { a: 1 }, summary: "z".repeat(7000), status: "confirmed", resultText: "Done." };
    await PUT(new Request("http://x/api/ai-suite/thread", { method: "PUT", body: JSON.stringify({ level: "sub-account", subAccountId: "sa1", messages: [message] }) }));
    expect(storedMessage()).toMatchObject({ status: "confirmed", args: { a: 1 }, resultText: "Done." });
  });
});
