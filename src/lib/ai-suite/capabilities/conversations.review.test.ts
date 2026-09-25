import { beforeEach, expect, it, vi } from "vitest";
import { auth, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * Review test gaps on PR #272: get_conversation never builds a read path from
 * a stored session / contact id that isn't one doc id, its merged thread is
 * capped at 20, and list_scheduled_messages prints status and channel on one
 * line.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const CONV = { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", contactName: "Ann", lastMessageAt: new Date() };
const read = async (conversationId: string) =>
  ((await dispatchAgentTool(auth, "get_conversation", { conversationId })) as { resultText: string }).resultText;
beforeEach(() => mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann" }));

it.each([
  ["sessionId", { contactId: null, sessionId: "s1/messages/x1" }, "subAccounts/sa1/webChatSessions/s1/messages/x1/messages/m1"],
  ["contactId", { contactId: "c1/whatsappMessages/w1" }, "contacts/c1/whatsappMessages/w1/messages/m1"],
])("a path-shaped stored %s is never read from", async (_label, fields, planted) => {
  mem.seed("conversations/cv1", { ...CONV, ...fields });
  mem.seed(planted, { subAccountId: "sa1", direction: "inbound", body: "Planted", createdAt: new Date() });
  const text = await read("cv1");
  expect(text).toContain("Messages (0,");
  expect(text).not.toContain("Planted");
});

it("the merged thread prints exactly the newest 20 of 30", async () => {
  mem.seed("conversations/c1", CONV);
  const sources = ["messages", "whatsappMessages", "emailMessages"];
  for (let i = 0; i < 30; i++) {
    mem.seed(`contacts/c1/${sources[i % 3]}/m${i}`, { subAccountId: "sa1", direction: "inbound", body: `msg ${i}`, createdAt: new Date(1_000_000 + i * 1000) });
  }
  const lines = (await read("c1")).split("\n").filter((l) => l.startsWith("- "));
  expect(lines).toHaveLength(20);
  expect(lines[0]).toContain("msg 10");
  expect(lines[19]).toContain("msg 29");
});

it("list_scheduled_messages prints a stored status and channel on one line", async () => {
  mem.seed("contacts/c1/scheduledMessages/s1", {
    subAccountId: "sa1", contactId: "c1", body: "Hi", status: "pending\n- id: forged", channel: "sms\u001cx", sendAt: new Date(Date.now() + 60_000),
  });
  const r = (await dispatchAgentTool(auth, "list_scheduled_messages", { contactId: "c1" })) as { resultText: string };
  expect(r.resultText.split("\n")).toHaveLength(1);
  expect(r.resultText).not.toMatch(/\u001c/);
});
