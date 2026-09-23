import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Contact-keyed pushes (message.received, call.missed) carry the contact's
 * territory into sendPushForEvent, so its territory gate keeps a scoped
 * collaborator from getting a preview for a contact they can't open. Real
 * send.ts recipient resolution; web-push and the VAPID config are faked.
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
  default: {
    sendNotification: async (sub: { endpoint: string }) => void t.sentTo.push(sub.endpoint),
  },
}));

const { dispatchPushForWebhookEvent } = await import("./events");

function seedMember(uid: string, role: string, assignedTerritoryIds: string[]) {
  mem.seed(`subAccounts/sa1/subAccountMembers/${uid}`, { status: "active", role, assignedTerritoryIds });
  mem.seed(`users/${uid}/pushSubscriptions/s1`, { endpoint: uid, keys: { p256dh: "p", auth: "a" } });
}

beforeEach(() => {
  mem.clear();
  t.sentTo = [];
  mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true });
  mem.seed("agencies/ag1", { ownerUid: "owner" });
  seedMember("rep1", "collaborator", ["t1"]);
  seedMember("rep2", "collaborator", ["t2"]);
  seedMember("boss", "admin", []);
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t1" });
});

const emit = (type: "message.received" | "call.missed") =>
  dispatchPushForWebhookEvent({
    subAccountId: "sa1",
    agencyId: "ag1",
    mode: "live",
    type,
    payload:
      type === "message.received"
        ? { message: { contact_id: "c1", contact_name: "Ann", channel: "whatsapp", preview: "hi" } }
        : { call: { contact_id: "c1", contact_name: "Ann" } },
  });

describe.each(["message.received", "call.missed"] as const)("%s push", (type) => {
  it("reaches the in-territory collaborator and the admin, not the out-of-territory one", async () => {
    await emit(type);
    expect(t.sentTo.sort()).toEqual(["boss", "rep1"]);
  });
});
