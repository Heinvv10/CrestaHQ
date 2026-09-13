import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * SP2 (d) extraction parity for POST /api/comms/whatsapp/send — the branches
 * route.test.ts (rail refusals + attachments) does not reach: no phone,
 * opt-out, agency gate, readiness, the closed-window 409 wording (with the
 * configured window length), quota, and the dispatcher arguments — above all
 * `humanReply: true` and `template: null`. Written against the pre-extraction
 * route first (it passed there).
 */

const mem = createMemoryFirestore();
const m = vi.hoisted(() => ({
  contact: vi.fn(),
  readiness: vi.fn(),
  dispatch: vi.fn(),
  windowHours: null as number | null,
  upsert: vi.fn(),
}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/route-auth", () => ({
  requireUid: () => ({ uid: "u1", email: "op@example.com" }),
  requireContactAccessible: m.contact,
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({ checkWhatsappReadiness: m.readiness }));
vi.mock("@/lib/comms/whatsapp/send-dispatch", () => ({ dispatchWhatsappSend: m.dispatch }));
vi.mock("@/lib/comms/ai/agent", () => ({
  getChannelConfig: async () =>
    m.windowHours === null ? null : { whatsapp: { sessionWindowHours: m.windowHours } },
}));
vi.mock("@/lib/comms/twilio", () => ({ sendWhatsappForSubAccount: vi.fn() }));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: m.upsert,
}));

const { POST } = await import("./route");
const { UsageQuotaExceededError } = await import("@/lib/server/usage-meter");

const CONTACT = { id: "c1", agencyId: "ag1", subAccountId: "sa1", name: "Ann", phone: "+27820000001" };
const ok = { contactId: "c1", body: " Hi " };
async function post(body: unknown) {
  const res = await POST(
    new Request("https://crm.test/api/comms/whatsapp/send", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  m.windowHours = null;
  m.contact.mockResolvedValue({ ...CONTACT });
  m.readiness.mockResolvedValue({ ready: true, provider: "twilio" });
  m.dispatch.mockResolvedValue({ ok: true, provider: "twilio", messageId: "WA1" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", whatsappEnabledByAgency: true });
});

it("400 without a phone, 400 when opted out", async () => {
  m.contact.mockResolvedValue({ ...CONTACT, phone: "" });
  expect(await post(ok)).toEqual({ status: 400, json: { error: "This contact has no phone number." } });
  m.contact.mockResolvedValue({ ...CONTACT, whatsappOptedOut: true });
  expect(await post(ok)).toEqual({
    status: 400,
    json: { error: "This contact has opted out of WhatsApp." },
  });
  expect(m.dispatch).not.toHaveBeenCalled();
});

it("403 when the agency gate is off (or the sub-account is gone)", async () => {
  mem.seed("subAccounts/sa1", { agencyId: "ag1", whatsappEnabledByAgency: false });
  const off = { status: 403, json: { error: "WhatsApp is disabled for this sub-account by your agency." } };
  expect(await post(ok)).toEqual(off);
  mem.clear();
  expect(await post(ok)).toEqual(off);
});

it("503 with the readiness error", async () => {
  m.readiness.mockResolvedValue({ ready: false, provider: "cloud", error: "WhatsApp Cloud isn't connected." });
  expect(await post(ok)).toEqual({ status: 503, json: { error: "WhatsApp Cloud isn't connected." } });
});

it("409 session_window_closed, naming the configured window", async () => {
  m.windowHours = 12;
  m.dispatch.mockResolvedValue({
    ok: false,
    provider: "twilio",
    error: "WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE",
  });
  expect(await post(ok)).toEqual({
    status: 409,
    json: {
      error:
        "WhatsApp's 12-hour messaging window is closed — the contact hasn't messaged within that time. Re-opening the conversation requires an approved message template.",
      code: "session_window_closed",
    },
  });
});

it("an AMBIGUOUS rail refusal answers exactly as before — no internal flag leaks into the body", async () => {
  m.dispatch.mockResolvedValue({
    ok: false,
    provider: "bridge",
    refusedBy: "some_future_rail",
    error: "bridge timed out",
    providerOutcome: "AMBIGUOUS",
  });
  expect(await post(ok)).toEqual({
    status: 409,
    json: { error: "bridge timed out", code: "some_future_rail" },
  });
});

it("429 on quota, 502 on a throw", async () => {
  m.dispatch.mockRejectedValueOnce(new UsageQuotaExceededError("whatsappMessages"));
  expect((await post(ok)).status).toBe(429);
  m.dispatch.mockRejectedValueOnce(new Error("boom"));
  expect(await post(ok)).toEqual({ status: 502, json: { error: "boom" } });
});

it("dispatches a human free-form reply (no template) and records it", async () => {
  expect(await post(ok)).toEqual({ status: 200, json: { ok: true, sid: "WA1" } });
  expect(m.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      subAccountId: "sa1",
      contactId: "c1",
      to: CONTACT.phone,
      body: "Hi",
      windowHours: 24,
      template: null,
      humanReply: true,
      attachment: null,
    })
  );
  expect(m.dispatch.mock.calls[0][0]).not.toHaveProperty("idempotencyKey");
  expect(mem.read("contacts/c1/whatsappMessages/WA1")).toMatchObject({
    direction: "outbound",
    body: "Hi",
    sentByUid: "u1",
    attachment: null,
  });
  expect(mem.list("contacts/c1/activities")).toEqual([
    expect.objectContaining({ type: "whatsapp_sent", content: "WhatsApp: Hi", createdBy: "u1", meta: { sid: "WA1" } }),
  ]);
  expect(m.upsert).toHaveBeenCalledWith(
    expect.objectContaining({ channel: "whatsapp", direction: "outbound", pauseBot: true })
  );
});
