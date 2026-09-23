import { beforeEach, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The watchdog's "Follow-up needed: <contact>" push carries the contact's
 * territory, so sendPushForEvent's gate keeps it from collaborators who
 * can't open that contact. Real sweep + real send.ts recipient resolution;
 * the LLM judge, webhooks and web-push are faked.
 */

const mem = createMemoryFirestore();
const t = vi.hoisted(() => ({ sentTo: [] as string[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/push/config", () => ({
  pushIsConfigured: () => true,
  getVapidKeys: () => ({ publicKey: "pk", privateKey: "sk" }),
}));
vi.mock("web-push", () => ({
  default: { sendNotification: async (sub: { endpoint: string }) => void t.sentTo.push(sub.endpoint) },
}));
vi.mock("@/lib/comms/ai/openrouter", () => ({
  aiIsConfigured: () => true,
  callAi: async () => ({
    text: '{"needsFollowUp": true, "urgency": "high", "reason": "asked for a quote"}',
    totalTokens: 10,
  }),
}));
vi.mock("@/lib/comms/ai/agent", () => ({ getAgentProfile: async () => null }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));

const { runWatchdogSweep } = await import("./agents-watchdog-service");

function seedMember(uid: string, role: string, assignedTerritoryIds: string[]) {
  mem.seed(`subAccounts/sa1/subAccountMembers/${uid}`, { status: "active", role, assignedTerritoryIds });
  mem.seed(`users/${uid}/pushSubscriptions/s1`, { endpoint: uid, keys: { p256dh: "p", auth: "a" } });
}

async function sweepFor(contactTerritory: string | null) {
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Ann", territoryId: contactTerritory });
  await runWatchdogSweep();
  await vi.waitFor(() => expect(t.sentTo).toContain("boss"));
  await new Promise((r) => setTimeout(r, 20)); // let every recipient's send land
  return t.sentTo.sort();
}

beforeEach(() => {
  mem.clear();
  t.sentTo = [];
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1", territoryScopingEnabled: true, labsEnabledByAgency: true, aiSuiteEnabledByAgency: true,
  });
  mem.seed("customAgents/sa1", { enabled: true, thresholdHours: 1 });
  mem.seed("conversations/c1", {
    subAccountId: "sa1", agencyId: "ag1", contactId: "c1", contactName: "Ann",
    lastDirection: "inbound", lastChannel: "sms", status: "open",
    lastMessageAt: Timestamp.fromMillis(Date.now() - 5 * 3_600_000),
  });
  seedMember("rep1", "collaborator", ["t1"]);
  seedMember("rep2", "collaborator", ["t2"]);
  seedMember("boss", "admin", []);
});

it("reaches the admin and the in-territory collaborator only", async () => {
  expect(await sweepFor("t1")).toEqual(["boss", "rep1"]);
});

it("an untagged contact reaches admins only", async () => {
  expect(await sweepFor(null)).toEqual(["boss"]);
});

it("a Global contact reaches everyone", async () => {
  expect(await sweepFor("global")).toEqual(["boss", "rep1", "rep2"]);
});
