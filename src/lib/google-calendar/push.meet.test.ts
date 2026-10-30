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

import { state } from "@/test/google-oauth-harness";
import { PAGE, connect, event, resetGcal, seedEvent, setGate, stubProvider, type StubProvider } from "@/test/gcal-harness";
import { GbpProviderError } from "@/lib/gbp/provider/types";
import type { GcalEventInput } from "./provider/types";
import { googleEventIdFor, pushBookingAndGetMeetUrl, pushBookingToGoogle } from "./push";

let provider: StubProvider;
const MEET_LINK = "https://meet.google.com/abc-defg-hij";
const gid = (uid: string) => googleEventIdFor("ev_1", uid);
const sentTo = (uid: string) =>
  provider.putEvent.mock.calls.find(([token]) => token === `a-${uid}`)?.[2] as GcalEventInput | undefined;

/** A booking on page "p", which offers Google Meet. */
function seedMeetBooking(over: Record<string, unknown> = {}) {
  seedEvent({ meetingUrl: null, location: "Google Meet video call", ...over });
  state.docs.set(PAGE, { ...state.docs.get(PAGE), location: { type: "google_meet", value: null }, googleMeet: true });
}

beforeEach(() => {
  resetGcal();
  provider = stubProvider();
  provider.putEvent.mockImplementation(async (_t: string, _id: string, input: GcalEventInput) => ({
    created: true,
    meetUrl: input.conferenceData ? MEET_LINK : null,
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
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
    expect(event()).toMatchObject({ meetingUrl: MEET_LINK, googleEventIds: { host_a: gid("host_a") } });
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

  it("an operator's link edited while Google was making the room wins: it is not overwritten", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: "https://zoom.example/fallback" });
    provider.putEvent.mockImplementationOnce(async () => {
      state.docs.set("events/ev_1", { ...event(), meetingUrl: "https://zoom.example/operator" });
      return { created: true, meetUrl: MEET_LINK };
    });
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: null });
    expect(event().meetingUrl).toBe("https://zoom.example/operator");
  });

  it("an event whose link was cleared meanwhile still takes the room's link", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: "https://zoom.example/fallback" });
    provider.putEvent.mockImplementationOnce(async () => {
      state.docs.set("events/ev_1", { ...event(), meetingUrl: null });
      return { created: true, meetUrl: MEET_LINK };
    });
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: MEET_LINK });
    expect(event().meetingUrl).toBe(MEET_LINK);
  });

  it("a room just made replaces the page's fallback link on the event", async () => {
    connect("host_a");
    seedMeetBooking({ meetingUrl: "https://zoom.example/fallback" });
    expect(await pushBookingAndGetMeetUrl("ev_1")).toEqual({ meetUrl: MEET_LINK });
    expect(event().meetingUrl).toBe(MEET_LINK);
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
