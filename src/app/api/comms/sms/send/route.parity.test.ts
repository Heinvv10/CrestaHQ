import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * SP2 (d) extraction parity for POST /api/comms/sms/send: every response the
 * route gave before its checks moved into the conversation send service —
 * status AND body — plus the writes a send makes. Written against the
 * pre-extraction route first (it passed there), so this file is the proof
 * the thin wrapper did not change behaviour.
 */

const mem = createMemoryFirestore();
const m = vi.hoisted(() => ({
  send: vi.fn(),
  upsert: vi.fn(),
  usage: vi.fn(),
  contact: vi.fn(),
}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/route-auth", () => ({
  requireUid: () => ({ uid: "u1", email: "op@example.com" }),
  requireContactAccessible: m.contact,
}));
vi.mock("@/lib/comms/twilio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/twilio")>()),
  sendSmsForSubAccount: m.send,
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: m.upsert,
}));
vi.mock("@/lib/comms/usage", () => ({ recordSend: m.usage }));

const { POST } = await import("./route");
const { SmsRecipientUnsubscribedError } = await import("@/lib/comms/twilio");
const { UsageQuotaExceededError } = await import("@/lib/server/usage-meter");

const CONTACT = { id: "c1", agencyId: "ag1", subAccountId: "sa1", name: "Ann", phone: "+27820000001" };
const TWILIO = { enabled: true, accountSid: "AC1", authToken: "t", fromNumber: "+15550001" };

async function post(body: unknown) {
  const res = await POST(
    new Request("https://crm.test/api/comms/sms/send", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, json: await res.json() };
}
const ok = { contactId: "c1", body: " Hello " };

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_ACCOUNT_SID", "");
  m.contact.mockResolvedValue({ ...CONTACT });
  m.send.mockResolvedValue({ sid: "SM1", mode: "dedicated", from: TWILIO.fromNumber });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", twilioConfig: TWILIO });
  mem.seed("contacts/c1", { ...CONTACT });
});
afterEach(() => vi.unstubAllEnvs());

it("400 without contactId or body", async () => {
  expect(await post({ contactId: "c1", body: "  " })).toEqual({
    status: 400,
    json: { error: "contactId and body are required" },
  });
});

it("passes the access check's refusal through", async () => {
  m.contact.mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
  expect(await post(ok)).toEqual({ status: 403, json: { error: "Forbidden" } });
});

it("400 when the contact has no phone", async () => {
  m.contact.mockResolvedValue({ ...CONTACT, phone: "" });
  expect(await post(ok)).toEqual({
    status: 400,
    json: { error: "This contact has no phone number." },
  });
});

it("409 for a carrier STOP and for declined consent", async () => {
  m.contact.mockResolvedValue({ ...CONTACT, smsOptedOut: true });
  expect(await post(ok)).toEqual({
    status: 409,
    json: {
      error:
        "This contact has opted out of SMS (replied STOP). They must text START to opt back in.",
    },
  });
  m.contact.mockResolvedValue({ ...CONTACT, smsConsent: { consented: false } });
  expect(await post(ok)).toEqual({
    status: 409,
    json: { error: "This contact declined SMS consent on a form." },
  });
  expect(m.send).not.toHaveBeenCalled();
});

it("503 when neither dedicated nor shared Twilio is configured", async () => {
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  expect(await post(ok)).toEqual({
    status: 503,
    json: { error: "SMS is not configured on this deployment." },
  });
});

it("dedicated send: trimmed body, message row, activity, inbox index, usage", async () => {
  expect(await post(ok)).toEqual({
    status: 200,
    json: { ok: true, sid: "SM1", mode: "dedicated" },
  });
  expect(m.send).toHaveBeenCalledWith(
    expect.objectContaining({ subAccountId: "sa1", to: CONTACT.phone, body: "Hello" })
  );
  expect(mem.read("contacts/c1/messages/SM1")).toMatchObject({
    agencyId: "ag1",
    subAccountId: "sa1",
    direction: "outbound",
    body: "Hello",
    from: TWILIO.fromNumber,
    sentByUid: "u1",
  });
  expect(mem.list("contacts/c1/activities")).toEqual([
    expect.objectContaining({ type: "sms_sent", content: "SMS: Hello", createdBy: "u1", meta: { sid: "SM1", mode: "dedicated" } }),
  ]);
  expect(m.upsert).toHaveBeenCalledWith(
    expect.objectContaining({ channel: "sms", direction: "outbound", body: "Hello", pauseBot: true })
  );
  expect(m.usage).toHaveBeenCalledWith("u1", "sms");
});

it("shared send writes no thread row and no inbox index", async () => {
  m.send.mockResolvedValue({ sid: "SM2", mode: "shared", from: "+1999" });
  expect(await post(ok)).toEqual({ status: 200, json: { ok: true, sid: "SM2", mode: "shared" } });
  expect(mem.list("contacts/c1/messages")).toHaveLength(0);
  expect(m.upsert).not.toHaveBeenCalled();
});

it("429 on quota, 502 on a provider failure", async () => {
  m.send.mockRejectedValueOnce(new UsageQuotaExceededError("smsSegments"));
  const quota = await post(ok);
  expect(quota.status).toBe(429);
  expect(quota.json.error).toMatch(/limit reached/);
  m.send.mockRejectedValueOnce(new Error("twilio down"));
  expect(await post(ok)).toEqual({ status: 502, json: { error: "twilio down" } });
});

it("409 on Twilio 21610, recording the opt-out on the contact", async () => {
  m.send.mockRejectedValueOnce(new SmsRecipientUnsubscribedError(CONTACT.phone));
  const res = await post(ok);
  expect(res.status).toBe(409);
  expect(res.json.error).toMatch(/21610/);
  expect(mem.read("contacts/c1")?.smsOptedOut).toBe(true);
  expect(mem.list("contacts/c1/activities")).toEqual([
    expect.objectContaining({ type: "automation_step_skipped", createdBy: "u1" }),
  ]);
});
