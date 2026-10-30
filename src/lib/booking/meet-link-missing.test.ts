import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/** The meet_link_missing timeline row's writes and rewrites. */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const {
  MEET_LINK_NOT_EMAILED_NOTE,
  MEET_LINK_ON_BOOKING_NOTE,
  MEET_LINK_SENT_NOTE,
  meetLinkMissingNote,
  recordMeetLinkMissing,
  settleMeetLinkPending,
  settleMeetLinkRows,
} = await import("./meet-link-missing");

const row = (id: string, meta: Record<string, unknown>) =>
  mem.seed(`contacts/c1/activities/${id}`, { type: "meet_link_missing", content: meetLinkMissingNote(true), meta });

beforeEach(() => {
  mem.clear();
  mem.seed("events/e1", { contactId: "c1", subAccountId: "sa1", meetingUrl: null });
  mem.seed("contacts/c1", { subAccountId: "sa1" });
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

  it("a link reached the booking another way meanwhile: the rows say it is on the booking now", async () => {
    mem.seed("events/e1", { contactId: "c1", subAccountId: "sa1", meetingUrl: "https://meet.google.com/x" });
    row("a1", { eventId: "e1", pending: true });
    await settleMeetLinkPending("e1");
    expect(mem.read("contacts/c1/activities/a1")).toMatchObject({ content: MEET_LINK_ON_BOOKING_NOTE, meta: { pending: false } });
  });
});

describe("settleMeetLinkRows", () => {
  it("rewrites only this booking's OPEN rows; a resolved one stays resolved", async () => {
    row("a1", { eventId: "e1", pending: true });
    mem.seed("contacts/c1/activities/a2", { type: "meet_link_missing", content: MEET_LINK_SENT_NOTE, meta: { eventId: "e1", resolved: true } });
    await settleMeetLinkRows({ contactId: "c1", subAccountId: "sa1" }, "e1", "not_emailed");
    expect(mem.read("contacts/c1/activities/a1")).toMatchObject({ content: MEET_LINK_NOT_EMAILED_NOTE, meta: { pending: false } });
    expect(mem.read("contacts/c1/activities/a2")).toMatchObject({ content: MEET_LINK_SENT_NOTE, meta: { resolved: true } });
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
    mem.seed("events/e1", { contactId: "c1", subAccountId: "sa1", meetingUrl: "https://meet.google.com/late" });
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

/**
 * A legacy event can still hold a contactId from ANOTHER sub-account. None of
 * the booking's timeline writers may touch that contact (route.foreign-contact
 * pattern): the contact must be in the event's own sub-account.
 */
describe("never another tenant's timeline", () => {
  beforeEach(() => {
    mem.seed("contacts/theirs", { subAccountId: "sa2" });
    mem.seed("events/e1", { contactId: "theirs", subAccountId: "sa1", meetingUrl: null });
    mem.seed("contacts/theirs/activities/t1", { type: "meet_link_missing", content: "theirs", meta: { eventId: "e1", pending: true } });
  });
  const theirs = () => mem.list("contacts/theirs/activities");

  it("recordMeetLinkMissing writes no row", async () => {
    await recordMeetLinkMissing({ contactId: "theirs", eventId: "e1", agencyId: "ag1", subAccountId: "sa1", pending: true });
    expect(theirs()).toHaveLength(1);
  });

  it.each([["sent"], ["not_emailed"], ["link_changed"]] as const)("settleMeetLinkRows (%s) rewrites nothing", async (outcome) => {
    await settleMeetLinkRows({ contactId: "theirs", subAccountId: "sa1" }, "e1", outcome);
    expect(theirs()).toEqual([expect.objectContaining({ content: "theirs", meta: { eventId: "e1", pending: true } })]);
  });

  it("settleMeetLinkPending rewrites nothing", async () => {
    await settleMeetLinkPending("e1");
    expect(theirs()).toEqual([expect.objectContaining({ content: "theirs" })]);
  });
});
