import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/** The meet_link_missing timeline row's writes and rewrites. */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { MEET_LINK_ON_BOOKING_NOTE, MEET_LINK_SENT_NOTE, meetLinkMissingNote, recordMeetLinkMissing, settleMeetLinkPending } =
  await import("./meet-link-missing");

const row = (id: string, meta: Record<string, unknown>) =>
  mem.seed(`contacts/c1/activities/${id}`, { type: "meet_link_missing", content: meetLinkMissingNote(true), meta });

beforeEach(() => {
  mem.clear();
  mem.seed("events/e1", { contactId: "c1", meetingUrl: null });
});

describe("settleMeetLinkPending", () => {
  it("rewrites this booking's 'being created' rows to the no-link wording", async () => {
    row("a1", { eventId: "e1", pending: true });
    row("a2", { eventId: "e2", pending: true });
    // This booking's row from a failed-in-time push (not pending): left as is.
    mem.seed("contacts/c1/activities/a3", { type: "meet_link_missing", content: "earlier note", meta: { eventId: "e1", pending: false } });
    await settleMeetLinkPending("e1");
    expect(mem.read("contacts/c1/activities/a1")).toMatchObject({ content: meetLinkMissingNote(false), meta: { pending: false } });
    expect(mem.read("contacts/c1/activities/a2")).toMatchObject({ content: meetLinkMissingNote(true), meta: { pending: true } });
    expect(mem.read("contacts/c1/activities/a3")).toMatchObject({ content: "earlier note" });
  });

  it("leaves them when a link reached the booking meanwhile", async () => {
    mem.seed("events/e1", { contactId: "c1", meetingUrl: "https://meet.google.com/x" });
    row("a1", { eventId: "e1", pending: true });
    await settleMeetLinkPending("e1");
    expect(mem.read("contacts/c1/activities/a1")).toMatchObject({ meta: { pending: true } });
  });
});

describe("recordMeetLinkMissing", () => {
  it("writes the owed row, pending or not, while no late link has been emailed", async () => {
    await recordMeetLinkMissing({ contactId: "c1", eventId: "e1", agencyId: "ag1", subAccountId: "sa1", pending: true });
    expect(mem.list("contacts/c1/activities")).toEqual([
      expect.objectContaining({ content: meetLinkMissingNote(true), meta: { eventId: "e1", pending: true } }),
    ]);
  });

  it("the link reached the booking before the row (a late room stored meanwhile): not 'being created'", async () => {
    mem.seed("events/e1", { contactId: "c1", meetingUrl: "https://meet.google.com/late" });
    await recordMeetLinkMissing({ contactId: "c1", eventId: "e1", agencyId: "ag1", subAccountId: "sa1", pending: true });
    expect(mem.list("contacts/c1/activities")).toEqual([
      expect.objectContaining({ content: MEET_LINK_ON_BOOKING_NOTE, meta: { eventId: "e1", pending: false } }),
    ]);
  });

  it("the race: the late link's email already went out (its claim exists) — the row is written resolved", async () => {
    mem.seed("events/e1/reminderSends/meet-link-follow-up", { claimedAt: new Date() });
    await recordMeetLinkMissing({ contactId: "c1", eventId: "e1", agencyId: "ag1", subAccountId: "sa1", pending: true });
    expect(mem.list("contacts/c1/activities")).toEqual([
      expect.objectContaining({ content: MEET_LINK_SENT_NOTE, meta: { eventId: "e1", pending: false, resolved: true } }),
    ]);
  });
});
