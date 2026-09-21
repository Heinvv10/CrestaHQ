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

  it("booked is booked: a failed qstashMessageId write is logged, never a 5xx that invites a rebooking", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // The doc vanishes between publish and the bookkeeping write, so that
    // write throws (NOT_FOUND) — the publish itself succeeded.
    m.publish.mockImplementation(async (input: { body: { scheduledMessageId: string } }) => {
      await mem.db.doc(`contacts/c1/scheduledMessages/${input.body.scheduledMessageId}`).delete();
      return { messageId: "msg_2" };
    });
    await expect(book()).resolves.toEqual({ ok: true, id: expect.any(String) });
    expect(err).toHaveBeenCalledWith(
      "[scheduled-messages] booked; qstashMessageId write failed",
      expect.any(Error)
    );
    err.mockRestore();
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

describe("cancelScheduledMessage — cancel vs dismiss", () => {
  const MIN = 60_000;
  const seed = (
    id: string,
    status: string,
    times: { sendAgo?: number; claimAgo?: number | null } = {},
    subAccountId = "sa1"
  ) =>
    mem.seed(`contacts/c1/scheduledMessages/${id}`, {
      subAccountId,
      status,
      sendAt: new Date(NOW - (times.sendAgo ?? 0)),
      ...(times.claimAgo === undefined || times.claimAgo === null
        ? {}
        : { claimedAt: new Date(NOW - times.claimAgo) }),
    });
  const cancel = (id: string, subAccountId = "sa1") =>
    cancelScheduledMessage({ contactId: "c1", subAccountId, id, actorUid: "u2", nowMs: NOW });
  const row = (id: string) => mem.read(`contacts/c1/scheduledMessages/${id}`);

  it("pending → cancelled (not dismissed), recording who", async () => {
    seed("s1", "pending", { sendAgo: -3600_000 });
    expect(await cancel("s1")).toEqual({ ok: true, action: "cancelled" });
    expect(row("s1")).toMatchObject({ status: "cancelled", cancelledByUid: "u2" });
    expect(row("s1")?.dismissedAt).toBeUndefined();
  });

  it.each(["failed", "unconfirmed"])("%s → dismissed, keeping its status as the record", async (status) => {
    seed("s1", status);
    expect(await cancel("s1")).toEqual({ ok: true, action: "dismissed" });
    expect(row("s1")).toMatchObject({ status, dismissedByUid: "u2" });
    expect(await cancel("s1")).toMatchObject({ ok: false, status: 409 });
  });

  it("a FRESH sending message is refused — its send may be in flight right now", async () => {
    seed("s1", "sending", { sendAgo: 60 * MIN, claimAgo: 5 * MIN });
    expect(await cancel("s1")).toMatchObject({ ok: false, status: 409 });
    expect(row("s1")?.dismissedAt).toBeUndefined();
  });

  it("a STALE sending message (claimed >15 min ago; the worker died) → dismissed", async () => {
    seed("s1", "sending", { sendAgo: 20 * MIN, claimAgo: 16 * MIN });
    expect(await cancel("s1")).toEqual({ ok: true, action: "dismissed" });
    expect(row("s1")).toMatchObject({ status: "sending", dismissedByUid: "u2" });
  });

  it("with no claim time, staleness falls back to the send time", async () => {
    seed("fresh", "sending", { sendAgo: 5 * MIN });
    seed("stale", "sending", { sendAgo: 16 * MIN });
    expect(await cancel("fresh")).toMatchObject({ ok: false, status: 409 });
    expect(await cancel("stale")).toEqual({ ok: true, action: "dismissed" });
  });

  it.each(["sent", "cancelled"])("%s is refused", async (status) => {
    seed("s1", status, { sendAgo: 60 * MIN });
    expect(await cancel("s1")).toMatchObject({ ok: false, status: 409 });
    expect(row("s1")?.status).toBe(status);
    expect(row("s1")?.dismissedAt).toBeUndefined();
  });

  it("404s a message of another sub-account, or none", async () => {
    seed("s1", "pending", {}, "sa-other");
    expect(await cancel("s1")).toMatchObject({ ok: false, status: 404 });
    expect(await cancel("missing")).toMatchObject({ ok: false, status: 404 });
    expect(row("s1")?.status).toBe("pending");
  });
});

describe("listScheduledMessages", () => {
  const seedAt = (id: string, status: string, ms: number, extra: Record<string, unknown> = {}) =>
    mem.seed(`contacts/c1/scheduledMessages/${id}`, {
      subAccountId: "sa1",
      status,
      body: id,
      sendAt: new Date(ms),
      ...extra,
    });

  it("a long history never pushes a pending message off the list", async () => {
    // 150 sent in the past AND 150 cancelled bookings further out than the
    // pending one — either would crowd it out of a single capped query.
    for (let i = 0; i < 150; i++) seedAt(`old${i}`, "sent", NOW - (i + 1) * 60_000);
    for (let i = 0; i < 150; i++) seedAt(`later${i}`, "cancelled", NOW + (i + 10) * 3600_000);
    seedAt("live", "pending", NOW + 3600_000);
    seedAt("inflight", "sending", NOW - 30_000);
    const ids = (await listScheduledMessages("c1", "sa1")).map((x) => x.id);
    expect(ids).toContain("live");
    expect(ids).toContain("inflight");
  });

  it("carries the claim time, so the thread can tell a stuck send from a live one", async () => {
    seedAt("stuck", "sending", NOW - 20 * 60_000, { claimedAt: new Date(NOW - 16 * 60_000) });
    const [view] = await listScheduledMessages("c1", "sa1");
    expect(view.claimedAt).toBe(new Date(NOW - 16 * 60_000).toISOString());
  });

  it("leaves dismissed messages out", async () => {
    seedAt("f1", "failed", NOW, { dismissedAt: new Date(NOW) });
    seedAt("f2", "failed", NOW);
    expect((await listScheduledMessages("c1", "sa1")).map((x) => x.id)).toEqual(["f2"]);
  });

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
    expect(list[0].claimedAt).toBeNull();
  });
});
