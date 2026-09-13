import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Pushing bookings to hosts' calendars (G3) and who may be written to (S1). */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());
vi.mock("./provider/select", () => ({ getGcalProviderFor: vi.fn(async () => provider) }));

import { SUB_PATH, state } from "@/test/google-oauth-harness";
import { EVENT, at, conn, connect, event, resetGcal, seedEvent, setGate, stubProvider, ts, type StubProvider } from "@/test/gcal-harness";
import { GbpProviderError } from "@/lib/gbp/provider/types";
import { googleEventIdFor, pushBookingToGoogle, removeBookingFromGoogle } from "./push";

let provider: StubProvider;
const gid = (uid: string) => googleEventIdFor("ev_1", uid);

beforeEach(() => {
  resetGcal();
  provider = stubProvider();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("pushBookingToGoogle", () => {
  it("puts the event under a deterministic base32hex id, tagged with leadstackEventId", async () => {
    connect("host_a");
    seedEvent();
    await pushBookingToGoogle("ev_1");
    expect(gid("host_a")).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(provider.putEvent).toHaveBeenCalledWith("a-host_a", gid("host_a"), {
      status: "confirmed",
      summary: "Consult — Ada",
      description: "Q: hi",
      location: "https://meet.example/x",
      start: { dateTime: at(10).toISOString() },
      end: { dateTime: at(10, 30).toISOString() },
      extendedProperties: { private: { leadstackEventId: "ev_1" } },
    }, expect.any(AbortSignal));
    expect(event()).toMatchObject({ googleEventIds: { host_a: gid("host_a") }, googleSyncError: null });
  });

  it("reuses the stored id on reschedule", async () => {
    connect("host_a");
    seedEvent({ googleEventIds: { host_a: "g_old" }, startAt: ts(at(14)), endAt: ts(at(14, 30)) });
    await pushBookingToGoogle("ev_1");
    expect(provider.putEvent).toHaveBeenCalledWith("a-host_a", "g_old", expect.objectContaining({ start: { dateTime: at(14).toISOString() } }), expect.any(AbortSignal));
  });

  it("deletes the Google copy on cancel and clears the id — even with the gate off; gone already = removed", async () => {
    connect("host_a");
    setGate(false);
    seedEvent({ status: "cancelled", googleEventIds: { host_a: "g_old" } });
    provider.deleteEvent.mockRejectedValueOnce(new GbpProviderError("not_found", { status: 404 }));
    await pushBookingToGoogle("ev_1");
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_a", "g_old", expect.any(AbortSignal));
    expect(event()).toMatchObject({ googleEventIds: {}, googleSyncError: null });
  });

  it("leaves completed meetings alone, and writes nothing for a live booking while the gate is off", async () => {
    connect("host_a");
    seedEvent({ status: "completed", googleEventIds: { host_a: "g_old" } });
    await pushBookingToGoogle("ev_1");
    seedEvent();
    setGate(false);
    await pushBookingToGoogle("ev_1");
    expect(provider.putEvent).not.toHaveBeenCalled();
    expect(provider.deleteEvent).not.toHaveBeenCalled();
    expect(state.writes.filter((w) => w.path === EVENT)).toEqual([]);
  });

  it("collective: every host; a host taken off the event loses their copy", async () => {
    ["host_a", "host_b", "host_c"].forEach((u) => connect(u));
    seedEvent({ hostUids: ["host_a", "host_b"], googleEventIds: { host_c: "g_c" } });
    await pushBookingToGoogle("ev_1");
    expect(provider.putEvent).toHaveBeenCalledTimes(2);
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_c", "g_c", expect.any(AbortSignal));
    expect(Object.keys(event().googleEventIds as object).sort()).toEqual(["host_a", "host_b"]);
  });

  it("a reassign moves the Google copy: deleted for the old host, written for the new", async () => {
    connect("host_a");
    connect("host_b");
    seedEvent({ assignedToUid: "host_b", googleEventIds: { host_a: "g_a" } });
    await pushBookingToGoogle("ev_1");
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_a", "g_a", expect.any(AbortSignal));
    expect(event().googleEventIds).toEqual({ host_b: gid("host_b") });
  });

  it("a failure lands on the event (named host) and in lastPushError — busy's lastError untouched; never thrown", async () => {
    connect("host_a", { lastError: "busy note" });
    seedEvent();
    provider.putEvent.mockRejectedValueOnce(new GbpProviderError("rate_limited", { status: 429 }));
    await expect(pushBookingToGoogle("ev_1")).resolves.toBeUndefined();
    expect((event().googleSyncError as { message: string }).message).toBe("Not in HOST_A's Google Calendar: Google Calendar is rate-limiting requests.");
    expect(conn("host_a")).toMatchObject({ lastPushError: expect.stringMatching(/rate-limiting/), lastError: "busy note" });
    await pushBookingToGoogle("ev_1");
    expect(conn("host_a").lastPushError).toBeNull();
  });

  it("converges again when the event changed during the push", async () => {
    connect("host_a");
    seedEvent();
    provider.putEvent.mockImplementationOnce(async () => {
      state.docs.set(EVENT, { ...event(), status: "cancelled" });
    });
    await pushBookingToGoogle("ev_1");
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_a", gid("host_a"), expect.any(AbortSignal));
    expect(event().googleEventIds).toEqual({});
  });

  it("removeBookingFromGoogle takes every copy down regardless of status", async () => {
    connect("host_a");
    seedEvent({ googleEventIds: { host_a: "g_a" } });
    await removeBookingFromGoogle("ev_1");
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_a", "g_a", expect.any(AbortSignal));
  });
});

describe("who may be written to (S1/S2)", () => {
  it("skips a spoofed assignee who is not a host of the page, and records it", async () => {
    connect("mallory");
    seedEvent({ assignedToUid: "mallory" });
    await pushBookingToGoogle("ev_1");
    expect(provider.putEvent).not.toHaveBeenCalled();
    expect((event().googleSyncError as { message: string }).message).toMatch(/not an active host/);
  });

  it("skips a host who was removed from the sub-account", async () => {
    connect("host_a");
    state.docs.set(`${SUB_PATH}/subAccountMembers/host_a`, { uid: "host_a", status: "removed" });
    seedEvent();
    await pushBookingToGoogle("ev_1");
    expect(provider.putEvent).not.toHaveBeenCalled();
  });

  it("a hostless page pushes nowhere", async () => {
    connect("host_a");
    seedEvent({}, []);
    await pushBookingToGoogle("ev_1");
    expect(provider.putEvent).not.toHaveBeenCalled();
  });

  it("a collective event's server-set hostUids qualify even when the page no longer lists them", async () => {
    connect("host_z");
    seedEvent({ hostUids: ["host_z"], assignedToUid: "host_z" });
    await pushBookingToGoogle("ev_1");
    expect(provider.putEvent).toHaveBeenCalledWith("a-host_z", gid("host_z"), expect.anything(), expect.any(AbortSignal));
  });
});
