import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Google Meet through the booking push: one room per booking, made on the
 * assigned host's copy when it is first created, its link stored on the
 * event and carried by every other host's copy. An overwrite (reschedule)
 * never asks again, so the booker's link stays the same.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());
vi.mock("./provider/select", () => ({ getGcalProviderFor: vi.fn(async () => provider) }));
vi.mock("firebase-admin/firestore", async () => (await import("@/test/google-oauth-harness")).firestoreMock());
const followUp = vi.hoisted(() => vi.fn(async (_eventId: string, _url: string, _o?: unknown) => undefined));
vi.mock("@/lib/booking/meet-link-follow-up", () => ({ sendMeetLinkFollowUp: followUp }));
const settle = vi.hoisted(() => vi.fn(async (_eventId: string) => undefined));
vi.mock("@/lib/booking/meet-link-missing", () => ({ settleMeetLinkPending: settle }));

import { SUB_PATH, state } from "@/test/google-oauth-harness";
import { PAGE, connect, event, resetGcal, seedEvent, setGate, stubProvider, type StubProvider } from "@/test/gcal-harness";
import { GbpProviderError } from "@/lib/gbp/provider/types";
import type { GcalEventInput } from "./provider/types";
import { flushAfterResponse } from "@/lib/server/after-response";
import {
  KEPT_FOR_MEET_SUMMARY,
  googleEventIdFor,
  pushBookingAndGetMeetUrl,
  pushBookingAndGetMeetUrlWithin,
  pushBookingToGoogle,
  removeBookingFromGoogle,
} from "./push";

let provider: StubProvider;
const MEET_LINK = "https://meet.google.com/abc-defg-hij";
const gid = (uid: string) => googleEventIdFor("ev_1", uid);
const sentTo = (uid: string) =>
  provider.putEvent.mock.calls.find(([token]) => token === `a-${uid}`)?.[2] as GcalEventInput | undefined;

const FALLBACK = "https://zoom.example/fallback";
/** A page whose fallback is itself a fixed meet.google.com room (not this booking's own). */
const STATIC_MEET = "https://meet.google.com/static-room";

/** A booking on page "p", which offers Google Meet (fallback link FALLBACK unless `pageFallback`). */
function seedMeetBooking(over: Record<string, unknown> = {}, pageFallback: string | null = FALLBACK) {
  seedEvent({ meetingUrl: null, location: "Google Meet video call", ...over });
  state.docs.set(PAGE, {
    ...state.docs.get(PAGE),
    location: { type: "google_meet", value: null },
    googleMeet: true,
    meetingUrl: pageFallback,
  });
}

beforeEach(() => {
  resetGcal();
  followUp.mockClear();
  settle.mockClear();
  provider = stubProvider();
  provider.putEvent.mockImplementation(async (_t: string, _id: string, input: GcalEventInput) => ({
    created: true,
    meetUrl: input.conferenceData ? MEET_LINK : null,
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a Google Meet booking", () => {
  it("asks for one room on the assigned host's new copy, and stores + returns its link", async () => {
    connect("host_a");
    seedMeetBooking();
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: MEET_LINK });
    expect(sentTo("host_a")?.conferenceData).toEqual({
      createRequest: { requestId: `meet-${gid("host_a")}`, conferenceSolutionKey: { type: "hangoutsMeet" } },
    });
    expect(event()).toMatchObject({
      meetingUrl: MEET_LINK,
      googleMeetOwnerUid: "host_a",
      googleEventIds: { host_a: gid("host_a") },
    });
  });

  it("collective: the room is on the first host's copy only; the others carry its link", async () => {
    ["host_a", "host_b"].forEach((u) => connect(u));
    seedMeetBooking({ hostUids: ["host_a", "host_b"] });
    await pushBookingToGoogle("ev_1");
    expect(provider.putEvent).toHaveBeenCalledTimes(2);
    expect(provider.putEvent.mock.calls[0][0]).toBe("a-host_a");
    expect(sentTo("host_b")?.conferenceData).toBeUndefined();
    expect(sentTo("host_b")?.location).toBe(MEET_LINK);
  });

  it("a reschedule overwrites the copy without asking for a room, and the stored link stays", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: MEET_LINK, googleEventIds: { host_a: gid("host_a") } });
    provider.putEvent.mockResolvedValueOnce({ created: false, meetUrl: MEET_LINK });
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: MEET_LINK });
    expect(sentTo("host_a")?.conferenceData).toBeUndefined();
    expect(event().meetingUrl).toBe(MEET_LINK);
    expect(state.writes.filter((w) => w.path === "events/ev_1" && "meetingUrl" in (w.data ?? {}))).toEqual([]);
  });

  it("a room found on an overwrite never replaces an operator's own link", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: "https://zoom.example/operator", googleEventIds: { host_a: gid("host_a") } });
    provider.putEvent.mockResolvedValueOnce({ created: false, meetUrl: MEET_LINK });
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: null });
    expect(event().meetingUrl).toBe("https://zoom.example/operator");
  });

  it("an operator's link already on the event wins over a room just made, and is logged", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: "https://zoom.example/operator" });
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: null });
    expect(sentTo("host_a")?.conferenceData).toBeDefined();
    expect(event().meetingUrl).toBe("https://zoom.example/operator");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("holds its own meeting link"));
  });

  it("an operator's link edited while Google was making the room wins: it is not overwritten", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: FALLBACK });
    provider.putEvent.mockImplementationOnce(async () => {
      state.docs.set("events/ev_1", { ...event(), meetingUrl: "https://zoom.example/operator" });
      return { created: true, meetUrl: MEET_LINK };
    });
    // The in-time booking push, which may replace the fallback it read.
    expect(await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 5_000 })).toEqual({ meetUrl: null, pending: false });
    expect(event().meetingUrl).toBe("https://zoom.example/operator");
  });

  it("an event whose link was cleared meanwhile still takes the room's link", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: FALLBACK });
    provider.putEvent.mockImplementationOnce(async () => {
      state.docs.set("events/ev_1", { ...event(), meetingUrl: null });
      return { created: true, meetUrl: MEET_LINK };
    });
    expect(await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 5_000 })).toEqual({ meetUrl: MEET_LINK, pending: false });
    expect(event().meetingUrl).toBe(MEET_LINK);
  });

  it("the in-time booking push: a room just made replaces the page's fallback link on the event", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: FALLBACK });
    expect(await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 5_000 })).toEqual({ meetUrl: MEET_LINK, pending: false });
    expect(event().meetingUrl).toBe(MEET_LINK);
  });

  it.each([
    ["Retry sync / reassign (pushBookingToGoogle)", () => pushBookingToGoogle("ev_1")],
    ["pushBookingAndGetMeetUrl", () => pushBookingAndGetMeetUrl("ev_1")],
  ])("any other push (%s) leaves the fallback the booker has: the room is not stored over it", async (_l, run) => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: FALLBACK });
    await run();
    expect(sentTo("host_a")?.conferenceData).toBeDefined();
    expect(event().meetingUrl).toBe(FALLBACK);
    expect(event().googleMeetOwnerUid).toBeUndefined();
  });

  it("…but it still fills an empty link", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: null });
    await pushBookingToGoogle("ev_1");
    expect(event()).toMatchObject({ meetingUrl: MEET_LINK, googleMeetOwnerUid: "host_a" });
  });

  it("a reassign of a booking with no recorded room owner: the new host's copy carries the link, no new room", async () => {
    connect("host_a");
    connect("host_b");
    seedMeetBooking({ meetingUrl: MEET_LINK, assignedToUid: "host_b", googleEventIds: { host_a: gid("host_a") } });
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: MEET_LINK });
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_a", gid("host_a"), expect.any(AbortSignal));
    expect(sentTo("host_b")?.conferenceData).toBeUndefined();
    expect(sentTo("host_b")?.location).toBe(MEET_LINK);
    expect(event().meetingUrl).toBe(MEET_LINK);
  });

  it("a first push that timed out after Google made the room: the next push stores it over the fallback", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: FALLBACK });
    provider.putEvent.mockRejectedValueOnce(new GbpProviderError("transient"));
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: null });
    expect(event().meetingUrl).toBe(FALLBACK);
    // Google had made the event and its room: the insert now 409s into an
    // overwrite that finds it. A reschedule (which mails the link) may store it.
    provider.putEvent.mockResolvedValueOnce({ created: false, meetUrl: MEET_LINK });
    await pushBookingToGoogle("ev_1", { replaceFallback: true });
    expect(event().meetingUrl).toBe(MEET_LINK);
  });

  it("a page whose fallback is a fixed Meet URL still gets the booking its own room", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: STATIC_MEET }, STATIC_MEET);
    expect(await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 5_000 })).toEqual({ meetUrl: MEET_LINK, pending: false });
    expect(sentTo("host_a")?.conferenceData).toBeDefined();
    expect(event()).toMatchObject({ meetingUrl: MEET_LINK, googleMeetOwnerUid: "host_a" });
  });

  it("…and with no room made, the fixed fallback is not reported as the booking's room", async () => {
    seedMeetBooking({ meetingUrl: STATIC_MEET }, STATIC_MEET);
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: null });
  });

  it("Google failing: no link, nothing thrown, the failure recorded on the event", async () => {
    connect("host_a");
    seedMeetBooking();
    provider.putEvent.mockRejectedValueOnce(new GbpProviderError("transient", { status: 503 }));
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: null });
    expect(event().meetingUrl).toBeNull();
    expect(event().googleSyncError).toBeTruthy();
  });

  it("assigned host not connected: no room, no link", async () => {
    seedMeetBooking();
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: null });
    expect(provider.putEvent).not.toHaveBeenCalled();
  });

  it("Calendar sync switched off: nothing is written, no room", async () => {
    connect("host_a");
    setGate(false);
    seedMeetBooking();
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: null });
    expect(provider.putEvent).not.toHaveBeenCalled();
  });
});

describe("not a Google Meet booking", () => {
  it("never asks for a room, whatever the event says", async () => {
    connect("host_a");
    seedEvent({ location: "Google Meet video call" });
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: null });
    expect(sentTo("host_a")?.conferenceData).toBeUndefined();
  });

  it("an event with no booking page never asks for one", async () => {
    connect("host_a");
    seedMeetBooking({ bookingPageSlug: null });
    await pushBookingToGoogle("ev_1");
    expect(sentTo("host_a")?.conferenceData).toBeUndefined();
  });
});

describe("pushBookingAndGetMeetUrlWithin", () => {
  it("answers no link at the deadline while Google hangs; the push finishes detached and stores the room", async () => {
    connect("host_a");
    seedMeetBooking();
    let release: (v: { created: boolean; meetUrl: string | null }) => void = () => {};
    provider.putEvent.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const started = Date.now();
    expect(await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 50 })).toEqual({ meetUrl: null, pending: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(event().meetingUrl).toBeNull();
    release({ created: true, meetUrl: MEET_LINK });
    await flushAfterResponse();
    expect(event().meetingUrl).toBe(MEET_LINK);
    // The booker was told the link will follow: it does, once.
    expect(followUp).toHaveBeenCalledWith("ev_1", MEET_LINK, { pinnedEmail: undefined });
    expect(settle).not.toHaveBeenCalled();
  });

  it("the deadline firing while the room's link is being committed: the caller gets that link, no follow-up", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: FALLBACK });
    let commit: () => void = () => {};
    const paused = new Promise<void>((r) => (commit = r));
    // Pause the store transaction's write of the link, past the deadline.
    state.afterWrite = async (w) => {
      if (w.data && "meetingUrl" in w.data) await paused;
    };
    const answer = pushBookingAndGetMeetUrlWithin("ev_1", { ms: 30 });
    await new Promise((r) => setTimeout(r, 80));
    commit();
    expect(await answer).toEqual({ meetUrl: MEET_LINK, pending: false });
    await flushAfterResponse();
    expect(event().meetingUrl).toBe(MEET_LINK);
    expect(followUp).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("a commit stalled past the store-wait cap: the caller is answered 'pending' instead of waiting on", async () => {
    connect("host_a");
    seedMeetBooking();
    let commit: () => void = () => {};
    const paused = new Promise<void>((r) => (commit = r));
    state.afterWrite = async (w) => {
      if (w.data && "meetingUrl" in w.data) await paused;
    };
    const started = Date.now();
    expect(await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 30, storeWaitMs: 50 })).toEqual({ meetUrl: null, pending: true });
    expect(Date.now() - started).toBeLessThan(1_000);
    commit();
    await flushAfterResponse();
  });

  it("detached: the follow-up waits for the caller's confirmation and row (`after`)", async () => {
    connect("host_a");
    seedMeetBooking();
    let release: (v: { created: boolean; meetUrl: string | null }) => void = () => {};
    provider.putEvent.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    let confirmed: () => void = () => {};
    const after = new Promise<void>((r) => (confirmed = r));
    await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 50, after });
    release({ created: true, meetUrl: MEET_LINK });
    for (let i = 0; i < 20 && event().meetingUrl !== MEET_LINK; i++) await new Promise((r) => setTimeout(r, 5));
    expect(event().meetingUrl).toBe(MEET_LINK);
    await new Promise((r) => setTimeout(r, 20));
    expect(followUp).not.toHaveBeenCalled();
    confirmed();
    await flushAfterResponse();
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["withheld (null): nobody — still called, so it settles the row", null],
    ["pinned: that address only", "pinned@example.com"],
  ])("detached, followUpTo %s", async (_l, followUpTo) => {
    connect("host_a");
    seedMeetBooking();
    let release: (v: { created: boolean; meetUrl: string | null }) => void = () => {};
    provider.putEvent.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 50, followUpTo });
    release({ created: true, meetUrl: MEET_LINK });
    await flushAfterResponse();
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(followUp).toHaveBeenCalledWith("ev_1", MEET_LINK, { pinnedEmail: followUpTo });
  });

  it("detached and ended with no room: the 'being created' row is corrected; in time, it isn't touched", async () => {
    connect("host_a");
    seedMeetBooking();
    let fail: (e: Error) => void = () => {};
    provider.putEvent.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 50 });
    fail(new GbpProviderError("transient"));
    await flushAfterResponse();
    expect(settle).toHaveBeenCalledWith("ev_1");
    expect(followUp).not.toHaveBeenCalled();
    settle.mockClear();
    provider.putEvent.mockRejectedValueOnce(new GbpProviderError("transient"));
    await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 5_000 });
    await flushAfterResponse();
    expect(settle).not.toHaveBeenCalled();
  });

  it("detached, it never replaces the fallback the booker was just sent: the room stays off, no follow-up", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: FALLBACK });
    let release: (v: { created: boolean; meetUrl: string | null }) => void = () => {};
    provider.putEvent.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    expect(await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 50 })).toEqual({ meetUrl: null, pending: true });
    release({ created: true, meetUrl: MEET_LINK });
    await flushAfterResponse();
    expect(event().meetingUrl).toBe(FALLBACK);
    expect(event().googleMeetOwnerUid).toBeUndefined();
    expect(followUp).not.toHaveBeenCalled();
  });

  it("detached, a booking that already had its room (no new link stored): no follow-up", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: MEET_LINK, googleMeetOwnerUid: "host_a", googleEventIds: { host_a: gid("host_a") } });
    let release: (v: { created: boolean; meetUrl: string | null }) => void = () => {};
    provider.putEvent.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    expect((await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 50 })).pending).toBe(true);
    release({ created: false, meetUrl: MEET_LINK });
    await flushAfterResponse();
    expect(followUp).not.toHaveBeenCalled();
  });

  it("in time, the same room does replace the fallback, and no follow-up is needed", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: FALLBACK });
    expect(await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 5_000 })).toEqual({ meetUrl: MEET_LINK, pending: false });
    await flushAfterResponse();
    expect(event().meetingUrl).toBe(MEET_LINK);
    expect(followUp).not.toHaveBeenCalled();
  });

  it("returns the link when Google answers in time", async () => {
    connect("host_a");
    seedMeetBooking();
    expect(await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 5_000 })).toEqual({ meetUrl: MEET_LINK, pending: false });
  });

  it("a push that finished in time without a room is not pending", async () => {
    connect("host_a");
    seedMeetBooking();
    provider.putEvent.mockRejectedValueOnce(new GbpProviderError("transient"));
    expect(await pushBookingAndGetMeetUrlWithin("ev_1", { ms: 5_000 })).toEqual({ meetUrl: null, pending: false });
  });
});

describe("a reassigned Google Meet booking keeps the room owner's copy", () => {
  /** host_a's copy owns the room; the booking now belongs to host_b. */
  function seedReassigned(over: Record<string, unknown> = {}, pageFallback: string | null = FALLBACK) {
    connect("host_a");
    connect("host_b");
    seedMeetBooking({
      meetingUrl: MEET_LINK,
      assignedToUid: "host_b",
      googleMeetOwnerUid: "host_a",
      googleEventIds: { host_a: gid("host_a") },
      ...over,
    }, pageFallback);
  }

  it("keeps it, marked as kept for the conference and shown as free; the new host gets the link", async () => {
    seedReassigned();
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: MEET_LINK });
    expect(provider.deleteEvent).not.toHaveBeenCalled();
    const kept = sentTo("host_a")!;
    // No booker details: not the title (it names the customer), not the notes, not the link.
    expect(kept.summary).toBe(KEPT_FOR_MEET_SUMMARY);
    expect(kept.description).toMatch(/removed when the booking is cancelled, deleted or over/);
    expect(kept.location).toBe("");
    expect(JSON.stringify(kept)).not.toMatch(/Ada|Q: hi|meet\.google\.com/);
    expect(kept.transparency).toBe("transparent");
    expect(kept.conferenceData).toBeUndefined();
    expect(sentTo("host_b")).toMatchObject({ location: MEET_LINK });
    expect(sentTo("host_b")?.conferenceData).toBeUndefined();
    expect(event().googleEventIds).toEqual({ host_a: gid("host_a"), host_b: gid("host_b") });
    expect(event().googleMeetKeptUid).toBe("host_a");
  });

  it("the membership check failing keeps the copy untouched and records why", async () => {
    seedReassigned();
    state.failRead = (path) => path === `${SUB_PATH}/subAccountMembers/host_a`;
    await pushBookingToGoogle("ev_1");
    expect(provider.deleteEvent).not.toHaveBeenCalled();
    expect(sentTo("host_a")).toBeUndefined();
    expect(event().googleEventIds).toEqual({ host_a: gid("host_a"), host_b: gid("host_b") });
    expect((event().googleSyncError as { message: string }).message).toMatch(/Kept in HOST_A's Google Calendar for now/);
  });

  it("a cancel removes the kept copy with the rest", async () => {
    seedReassigned({ status: "cancelled", googleEventIds: { host_a: gid("host_a"), host_b: gid("host_b") } });
    await pushBookingToGoogle("ev_1");
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_a", gid("host_a"), expect.any(AbortSignal));
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_b", gid("host_b"), expect.any(AbortSignal));
    expect(event().googleEventIds).toEqual({});
  });

  it("deleting the booking removes the kept copy", async () => {
    seedReassigned({ googleEventIds: { host_a: gid("host_a"), host_b: gid("host_b") } });
    await removeBookingFromGoogle("ev_1");
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_a", gid("host_a"), expect.any(AbortSignal));
    expect(provider.deleteEvent).toHaveBeenCalledTimes(2);
  });

  it("an owner who left the sub-account is not kept: their copy is removed", async () => {
    seedReassigned();
    state.docs.set(`${SUB_PATH}/subAccountMembers/host_a`, { uid: "host_a", status: "removed" });
    await pushBookingToGoogle("ev_1");
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_a", gid("host_a"), expect.any(AbortSignal));
  });

  it("an owner who left with no connection: the id goes and the kept state is cleared", async () => {
    seedReassigned({ googleMeetKeptUid: "host_a" });
    state.docs.set(`${SUB_PATH}/subAccountMembers/host_a`, { uid: "host_a", status: "removed" });
    state.docs.delete(`${SUB_PATH}/private/googleCalendar_host_a`);
    await pushBookingToGoogle("ev_1");
    expect(event().googleEventIds).toEqual({ host_b: gid("host_b") });
    expect(event().googleMeetKeptUid).toBeNull();
  });

  it("a recorded owner keeps the room's copy even after the event's link was changed", async () => {
    seedReassigned({ meetingUrl: FALLBACK });
    await pushBookingToGoogle("ev_1");
    expect(provider.deleteEvent).not.toHaveBeenCalled();
    expect(sentTo("host_a")?.summary).toBe(KEPT_FOR_MEET_SUMMARY);
  });

  it("no owner and only the page's fixed Meet fallback: not a room, the old copy goes", async () => {
    seedReassigned({ googleMeetOwnerUid: null, meetingUrl: STATIC_MEET }, STATIC_MEET);
    await pushBookingToGoogle("ev_1");
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_a", gid("host_a"), expect.any(AbortSignal));
  });

  it("reassigned back to the owner: the copy is theirs again, unmarked and busy, and leaves kept state", async () => {
    seedReassigned({
      assignedToUid: "host_a",
      googleMeetKeptUid: "host_a",
      googleEventIds: { host_a: gid("host_a"), host_b: gid("host_b") },
    });
    await pushBookingToGoogle("ev_1");
    expect(sentTo("host_a")).toMatchObject({ summary: "Consult — Ada", transparency: "opaque" });
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_b", gid("host_b"), expect.any(AbortSignal));
    expect(event().googleMeetKeptUid).toBeNull();
  });

  it("an owner's copy that was never kept is written without any transparency", async () => {
    seedReassigned({ assignedToUid: "host_a", googleEventIds: { host_a: gid("host_a") } });
    await pushBookingToGoogle("ev_1");
    expect(sentTo("host_a")).toBeDefined();
    expect(sentTo("host_a")).not.toHaveProperty("transparency");
  });
});

describe("a finished meeting drops the copy kept only for the room", () => {
  function seedFinished(status: string, over: Record<string, unknown> = {}) {
    connect("host_a");
    connect("host_b");
    seedMeetBooking({
      status,
      meetingUrl: MEET_LINK,
      assignedToUid: "host_b",
      googleMeetOwnerUid: "host_a",
      googleMeetKeptUid: "host_a",
      googleEventIds: { host_a: gid("host_a"), host_b: gid("host_b") },
      ...over,
    });
  }

  it.each([["completed"], ["no_show"]])("%s: the former host's copy goes, the owner is cleared, the host's copy stays", async (status) => {
    seedFinished(status);
    await pushBookingToGoogle("ev_1");
    expect(provider.deleteEvent).toHaveBeenCalledTimes(1);
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_a", gid("host_a"), expect.any(AbortSignal));
    expect(provider.putEvent).not.toHaveBeenCalled();
    expect(event()).toMatchObject({ googleEventIds: { host_b: gid("host_b") }, googleMeetOwnerUid: null, googleMeetKeptUid: null });
  });

  it("an owner still on the booking keeps their copy; only the owner is cleared", async () => {
    seedFinished("completed", { assignedToUid: "host_a", googleMeetKeptUid: null, googleEventIds: { host_a: gid("host_a") } });
    await pushBookingToGoogle("ev_1");
    expect(provider.deleteEvent).not.toHaveBeenCalled();
    expect(event()).toMatchObject({ googleEventIds: { host_a: gid("host_a") }, googleMeetOwnerUid: null });
  });

  it("the former host disconnected: recorded on the booking, id kept", async () => {
    seedFinished("completed");
    connect("host_a", { status: "revoked" });
    await pushBookingToGoogle("ev_1");
    expect(provider.deleteEvent).not.toHaveBeenCalled();
    expect(event().googleEventIds).toEqual({ host_a: gid("host_a"), host_b: gid("host_b") });
    expect((event().googleSyncError as { message: string }).message).toMatch(/^Still in HOST_A's Google Calendar/);
  });
});
