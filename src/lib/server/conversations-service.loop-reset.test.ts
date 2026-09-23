import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Sticky resume for the AI reply-loop guard, through the REAL pause write and
 * the REAL controls read: once the guard has paused a conversation, the
 * guard's window restarts from that pause, so resuming the bot (or letting
 * the pause lapse) does not re-trip on the history that caused it.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: vi.fn(),
  resumeWaitingRunsOnReply: vi.fn(),
}));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => false,
  sendEmail: vi.fn(),
  tenantFrom: () => "",
}));

const { getConversationControls } = await import("./conversations-service");
const { pauseBotForReplyLoop } = await import("@/lib/comms/ai/loop-guard");

const HOUR = 60 * 60 * 1000;

beforeEach(() => mem.clear());

it("a loop pause moves the guard's reset marker past an older human reply", async () => {
  const humanAt = new Date(Date.now() - HOUR);
  mem.seed("conversations/c1", { subAccountId: "sa", lastHumanReplyAt: humanAt, botMode: "auto" });

  expect((await getConversationControls("c1")).loopResetAtMs).toBe(humanAt.getTime());

  const before = Date.now();
  expect(await pauseBotForReplyLoop("c1")).toBe(true);
  const { loopResetAtMs } = await getConversationControls("c1");
  expect(loopResetAtMs).toBeGreaterThanOrEqual(before);
  expect(loopResetAtMs).toBeLessThanOrEqual(Date.now());
});

it("a later human reply wins over an older loop pause", async () => {
  const pausedAt = new Date(Date.now() - 2 * HOUR);
  const humanAt = new Date(Date.now() - HOUR);
  mem.seed("conversations/c1", { subAccountId: "sa", aiLoopPausedAt: pausedAt, lastHumanReplyAt: humanAt });
  expect((await getConversationControls("c1")).loopResetAtMs).toBe(humanAt.getTime());
});
