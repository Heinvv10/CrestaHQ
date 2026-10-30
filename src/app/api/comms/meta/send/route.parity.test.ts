import { beforeEach, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * SP2 (d) extraction parity for POST /api/comms/meta/send: every refusal the
 * route gave before its checks moved into the conversation send service —
 * status AND body — and the writes a send makes. Written against the
 * pre-extraction route first (it passed there).
 */

const mem = createMemoryFirestore();
const m = vi.hoisted(() => ({ send: vi.fn(), upsert: vi.fn(), contact: vi.fn() }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/route-auth", () => ({
  requireUid: () => ({ uid: "u1", email: "op@example.com" }),
  requireContactAccessible: m.contact,
}));
vi.mock("@/lib/comms/meta", () => ({ sendMetaMessage: m.send }));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: m.upsert,
}));

const { POST } = await import("./route");

const CONTACT = { id: "c1", agencyId: "ag1", subAccountId: "sa1", name: "Ann", phone: "", metaUserId: "PSID1" };
const META = {
  connected: true,
  pageAccessToken: "PAGE_TOKEN",
  pageId: "PAGE1",
  instagramBusinessAccountId: "IG1",
};

async function post(body: unknown) {
  const res = await POST(
    new Request("https://crm.test/api/comms/meta/send", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, json: await res.json() };
}
const ok = { contactId: "c1", body: "Hello", channel: "messenger" };
const inbound = (channel: string, agoMs: number) =>
  mem.seed(`contacts/c1/metaMessages/in-${channel}-${agoMs}`, {
    direction: "inbound",
    channel,
    createdAt: Timestamp.fromMillis(Date.now() - agoMs),
  });
const seedSub = (data: Record<string, unknown>) =>
  mem.seed("subAccounts/sa1", { agencyId: "ag1", metaInboxEnabledByAgency: true, metaConfig: META, ...data });

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  m.contact.mockResolvedValue({ ...CONTACT });
  m.send.mockResolvedValue("mid.1");
  seedSub({});
  inbound("messenger", 3600_000);
});

it("400 when the contact has no Meta identity", async () => {
  m.contact.mockResolvedValue({ ...CONTACT, metaUserId: undefined });
  expect(await post(ok)).toEqual({
    status: 400,
    json: { error: "This contact hasn't messaged via Facebook/Instagram." },
  });
});

it("403 when the agency gate is off", async () => {
  seedSub({ metaInboxEnabledByAgency: false });
  expect(await post(ok)).toEqual({
    status: 403,
    json: {
      error:
        "The Facebook/Instagram inbox is disabled for this sub-account by your agency.",
    },
  });
});

it("503 without a connected Page, or a Page id", async () => {
  seedSub({ metaConfig: { ...META, connected: false } });
  expect(await post(ok)).toEqual({
    status: 503,
    json: { error: "No Facebook Page is connected. Connect one under Settings → Messaging." },
  });
  seedSub({ metaConfig: { ...META, pageId: "" } });
  expect(await post(ok)).toEqual({
    status: 503,
    json: {
      error: "The connected Page is missing its id — reconnect under Settings → Messaging.",
    },
  });
});

it("Instagram: 503 without a linked IG account, 403 without the DM scope", async () => {
  const ig = { ...ok, channel: "instagram" };
  seedSub({ metaConfig: { ...META, instagramBusinessAccountId: "" } });
  expect(await post(ig)).toEqual({
    status: 503,
    json: { error: "No Instagram business account is linked to the connected Page." },
  });
  seedSub({ metaConfig: { ...META, capabilities: { inbox: false, instagramDm: false } } });
  const scope = await post(ig);
  expect(scope.status).toBe(403);
  expect(scope.json.error).toMatch(/Instagram messaging permission/);
});

it("409 session_window_closed when the last inbound on THIS channel is 24h+ old", async () => {
  mem.clear();
  seedSub({});
  inbound("messenger", 24 * 3600_000 + 1000);
  inbound("instagram", 1000);
  expect(await post(ok)).toEqual({
    status: 409,
    json: {
      error:
        "Meta's 24-hour messaging window is closed — the contact hasn't messaged within that time. Re-opening the conversation needs a message tag (coming in a later release).",
      code: "session_window_closed",
    },
  });
  expect(m.send).not.toHaveBeenCalled();
});

it("502 when the Graph send throws", async () => {
  m.send.mockRejectedValue(new Error("(#10) outside window"));
  expect(await post(ok)).toEqual({ status: 502, json: { error: "(#10) outside window" } });
});

it("sends from the Page node and writes the row, activity and inbox index", async () => {
  expect(await post(ok)).toEqual({ status: 200, json: { ok: true, messageId: "mid.1" } });
  expect(m.send).toHaveBeenCalledWith({
    channel: "messenger",
    fromNodeId: "PAGE1",
    recipientId: "PSID1",
    text: "Hello",
    pageAccessToken: "PAGE_TOKEN",
  });
  expect(mem.read("contacts/c1/metaMessages/mid.1")).toMatchObject({
    channel: "messenger",
    direction: "outbound",
    from: "PAGE1",
    to: "PSID1",
    sentByUid: "u1",
  });
  expect(mem.list("contacts/c1/activities")).toEqual([
    expect.objectContaining({ type: "messenger_sent", content: "Messenger: Hello", createdBy: "u1" }),
  ]);
  expect(m.upsert).toHaveBeenCalledWith(
    expect.objectContaining({ channel: "messenger", contactPhone: null, pauseBot: true })
  );
});
