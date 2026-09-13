import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { Contact } from "@/types/contacts";
import type { ScheduleRequest } from "./parse";

/**
 * Booking and cancelling, over an in-memory Firestore with the REAL send-time
 * prechecks. QStash's publish is the one edge replaced.
 */

const mem = createMemoryFirestore();
const m = vi.hoisted(() => ({ publish: vi.fn(), configured: true }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/automations/qstash", () => ({
  publishCallback: m.publish,
  qstashIsConfigured: () => m.configured,
}));

const { scheduleConversationMessage, cancelScheduledMessage, listScheduledMessages } =
  await import("./service");

const NOW = Date.parse("2026-09-13T10:00:00Z");
const contact = {
  id: "c1",
  agencyId: "ag1",
  subAccountId: "sa1",
  name: "Ann",
  phone: "+27820000001",
  email: "ann@example.com",
} as Contact;
const request: ScheduleRequest = {
  contactId: "c1",
  channel: "sms",
  body: "See you at 3",
  subject: null,
  inReplyTo: null,
  references: null,
  sendAt: new Date(NOW + 90 * 60_000),
};
const book = (over: Partial<Contact> = {}, req = request) =>
  scheduleConversationMessage({
    request: req,
    contact: { ...contact, ...over },
    actorUid: "u1",
    nowMs: NOW,
  });
const rows = () => mem.list("contacts/c1/scheduledMessages");

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  m.configured = true;
  m.publish.mockResolvedValue({ messageId: "msg_1" });
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    twilioConfig: { enabled: true, accountSid: "AC1", authToken: "t", fromNumber: "+1555" },
    emailProvider: "smtp",
    smtpConfig: { verifiedAt: "2026-09-08", host: "smtp.example.com", fromEmail: "desk@example.com" },
  });
});

describe("scheduleConversationMessage", () => {
  it("books a pending doc with the tenancy keys and publishes the fire callback at sendAt", async () => {
    const r = await book();
    expect(r).toEqual({ ok: true, id: expect.any(String) });
    const [row] = rows();
    expect(row).toMatchObject({
      id: (r as { id: string }).id,
      agencyId: "ag1",
      subAccountId: "sa1",
      createdByUid: "u1",
      contactId: "c1",
      channel: "sms",
      body: "See you at 3",
      status: "pending",
      qstashMessageId: "msg_1",
    });
    expect(m.publish).toHaveBeenCalledWith({
      pathname: "/api/scheduled-messages/fire",
      body: { contactId: "c1", scheduledMessageId: row.id },
      delaySeconds: 90 * 60,
      deduplicationId: `scheduled_${row.id}`,
    });
  });

  it("refuses up front what the send would refuse now — nothing booked, nothing published", async () => {
    expect(await book({ smsOptedOut: true })).toMatchObject({ ok: false, status: 409 });
    expect(await book({ phone: "" })).toMatchObject({ ok: false, status: 400 });
    expect(
      await book({ emailOptedOut: true }, { ...request, channel: "email", subject: "Hi" })
    ).toMatchObject({ ok: false, status: 409, error: "This contact has opted out of email." });
    expect(rows()).toHaveLength(0);
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("refuses when QStash is not configured", async () => {
    m.configured = false;
    expect(await book()).toMatchObject({ ok: false, status: 503 });
    expect(rows()).toHaveLength(0);
  });

  it("a publish QStash refuses leaves a FAILED doc, never a pending one nothing will fire", async () => {
    m.publish.mockResolvedValue(null);
    expect(await book()).toMatchObject({ ok: false, status: 502 });
    const [row] = rows();
    expect(row).toMatchObject({
      status: "failed",
      failureReason: expect.stringMatching(/will not be sent/),
    });
  });
});

describe("cancelScheduledMessage", () => {
  const seed = (id: string, status: string, subAccountId = "sa1") =>
    mem.seed(`contacts/c1/scheduledMessages/${id}`, { subAccountId, status });
  const cancel = (id: string, subAccountId = "sa1") =>
    cancelScheduledMessage({ contactId: "c1", subAccountId, id, actorUid: "u2" });

  it("cancels a pending message and records who", async () => {
    seed("s1", "pending");
    expect(await cancel("s1")).toEqual({ ok: true });
    expect(mem.read("contacts/c1/scheduledMessages/s1")).toMatchObject({
      status: "cancelled",
      cancelledByUid: "u2",
    });
  });

  it.each(["sending", "sent", "failed", "cancelled"])("refuses once it is %s", async (status) => {
    seed("s1", status);
    expect(await cancel("s1")).toMatchObject({ ok: false, status: 409 });
    expect(mem.read("contacts/c1/scheduledMessages/s1")?.status).toBe(status);
  });

  it("404s a message of another sub-account, or none", async () => {
    seed("s1", "pending", "sa-other");
    expect(await cancel("s1")).toMatchObject({ ok: false, status: 404 });
    expect(await cancel("missing")).toMatchObject({ ok: false, status: 404 });
    expect(mem.read("contacts/c1/scheduledMessages/s1")?.status).toBe("pending");
  });
});

describe("listScheduledMessages", () => {
  it("lists the sub-account's messages soonest first, as ISO times", async () => {
    await book(undefined, { ...request, sendAt: new Date(NOW + 3 * 3600_000) });
    await book(undefined, { ...request, body: "sooner", sendAt: new Date(NOW + 3600_000) });
    mem.seed("contacts/c1/scheduledMessages/foreign", {
      subAccountId: "sa-other",
      sendAt: new Date(NOW),
    });
    const list = await listScheduledMessages("c1", "sa1");
    expect(list.map((x) => x.body)).toEqual(["sooner", "See you at 3"]);
    expect(list[0].sendAt).toBe(new Date(NOW + 3600_000).toISOString());
  });
});
