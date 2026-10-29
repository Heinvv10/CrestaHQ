import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Pushing bookings to hosts' calendars (G3) and who may be written to (S1). */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());
vi.mock("./provider/select", () => ({ getGcalProviderFor: vi.fn(async () => provider) }));
// Upcoming bookings a host attends: the harness's events, by assignee.
vi.mock("firebase-admin/firestore", async () => (await import("@/test/google-oauth-harness")).firestoreMock());
// Upcoming bookings a host attends: the harness's events, by assignee, with
// the caller's refine APPLIED (a `>=` on a Timestamp field) — so a caller
// that stopped asking for upcoming-only would see past bookings too.
vi.mock("@/lib/booking/hosts", async () => {
  const { state: s, adminMock } = await import("@/test/google-oauth-harness");
  const db = adminMock().getAdminDb();
  const ms = (v: unknown) => ((v as { toDate?: () => Date })?.toDate?.() ?? (v as Date)).getTime();
  return {
    queryHostEvents: async (_sa: string, uid: string, refine: (q: unknown) => unknown) => {
      const conds: Array<[string, string, Date]> = [];
      const q = { where: (f: string, op: string, v: Date) => (conds.push([f, op, v]), q) };
      refine(q);
      return [...s.docs.keys()]
        .filter((p) => p.startsWith("events/") && s.docs.get(p)?.assignedToUid === uid)
        .filter((p) => conds.every(([f, op, v]) => op !== ">=" || ms(s.docs.get(p)?.[f]) >= v.getTime()))
        .map((p) => ({ id: p.split("/")[1], data: () => s.docs.get(p), ref: db.doc(p) }));
    },
  };
});

import { SUB, SUB_PATH, state } from "@/test/google-oauth-harness";
import { EVENT, at, conn, connect, event, resetGcal, seedEvent, setGate, stubProvider, ts, type StubProvider } from "@/test/gcal-harness";
import { GbpProviderError } from "@/lib/gbp/provider/types";
import {
  googleEventIdFor,
  pushBookingToGoogle,
  removeBookingFromGoogle,
  removeBookingFromGoogleBeforeDelete,
  removeMemberGoogleCopies,
} from "./push";

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

describe("who may be written to", () => {
  it("skips an assignee who is not an active member, and records it", async () => {
    connect("mallory");
    state.docs.delete(`${SUB_PATH}/subAccountMembers/mallory`);
    seedEvent({ assignedToUid: "mallory" });
    await pushBookingToGoogle("ev_1");
    expect(provider.putEvent).not.toHaveBeenCalled();
    expect((event().googleSyncError as { message: string }).message).toMatch(/no longer an active member/);
  });

  it("skips a host who was removed from the sub-account", async () => {
    connect("host_a");
    state.docs.set(`${SUB_PATH}/subAccountMembers/host_a`, { uid: "host_a", status: "removed" });
    seedEvent();
    await pushBookingToGoogle("ev_1");
    expect(provider.putEvent).not.toHaveBeenCalled();
  });

  it("an active host taken off the page but still assigned keeps their copy — a reschedule MOVES it", async () => {
    connect("host_x");
    seedEvent({ assignedToUid: "host_x", googleEventIds: { host_x: "g_x" }, startAt: ts(at(14)), endAt: ts(at(14, 30)) });
    await pushBookingToGoogle("ev_1");
    expect(provider.deleteEvent).not.toHaveBeenCalled();
    expect(provider.putEvent).toHaveBeenCalledWith("a-host_x", "g_x", expect.objectContaining({ start: { dateTime: at(14).toISOString() } }), expect.any(AbortSignal));
    expect(event().googleEventIds).toEqual({ host_x: "g_x" });
  });

  it("a hostless page's assigned booking pushes to its assignee", async () => {
    connect("host_a");
    seedEvent({}, []);
    await pushBookingToGoogle("ev_1");
    expect(provider.putEvent).toHaveBeenCalledWith("a-host_a", gid("host_a"), expect.anything(), expect.any(AbortSignal));
  });
});

describe("a stale googleSyncError is cleared when there is nothing to do", () => {
  const STALE = { googleSyncError: { message: "old failure", at: new Date() } };
  it.each([
    ["completed", { status: "completed" }],
    ["cancelled with no Google copy", { status: "cancelled" }],
  ])("%s", async (_l, over) => {
    connect("host_a");
    seedEvent({ ...STALE, ...over });
    await pushBookingToGoogle("ev_1");
    expect(event().googleSyncError).toBeNull();
  });

  it("gate off", async () => {
    connect("host_a");
    setGate(false);
    seedEvent(STALE);
    await pushBookingToGoogle("ev_1");
    expect(event().googleSyncError).toBeNull();
    expect(provider.putEvent).not.toHaveBeenCalled();
  });
});

describe("removeMemberGoogleCopies", () => {
  it("deletes the member's copies of UPCOMING bookings only, dropping just their id", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(8));
    connect("host_a");
    seedEvent({ googleEventIds: { host_a: "g_a", host_b: "g_b" } });
    state.docs.set("events/past", { ...event(), id: "past", startAt: ts(at(6)), endAt: ts(at(6, 30)), googleEventIds: { host_a: "g_past" } });
    await removeMemberGoogleCopies(SUB, "host_a");
    vi.useRealTimers();
    expect(provider.deleteEvent).toHaveBeenCalledTimes(1);
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_a", "g_a", expect.any(AbortSignal));
    expect(event().googleEventIds).toEqual({ host_b: "g_b" });
    expect(state.writes.find((w) => w.path === EVENT && w.op === "update")?.data).toEqual({ "googleEventIds.host_a": "DELETE_FIELD" });
  });

  it("records a copy it could not remove on that booking", async () => {
    connect("host_a");
    seedEvent({ startAt: ts(new Date(Date.now() + 86_400_000)), endAt: ts(new Date(Date.now() + 88_000_000)), googleEventIds: { host_a: "g_a" } });
    provider.deleteEvent.mockRejectedValueOnce(new GbpProviderError("transient", { status: 503 }));
    await removeMemberGoogleCopies(SUB, "host_a");
    expect(event().googleEventIds).toEqual({ host_a: "g_a" });
    expect((event().googleSyncError as { message: string }).message).toMatch(/^Still in HOST_A's Google Calendar/);
  });
});

describe("removeBookingFromGoogleBeforeDelete", () => {
  it("reports a copy it could not remove, naming the host, and records it", async () => {
    connect("host_a");
    seedEvent({ googleEventIds: { host_a: "g_a" } });
    provider.deleteEvent.mockRejectedValueOnce(new GbpProviderError("transient", { status: 503 }));
    expect(await removeBookingFromGoogleBeforeDelete("ev_1")).toEqual({
      ok: false,
      message: "Couldn't remove it from HOST_A's Google Calendar — try again.",
    });
    expect(event().googleEventIds).toEqual({ host_a: "g_a" });
    expect(event().googleSyncError).toBeTruthy();
  });

  it("ok once every copy is gone", async () => {
    connect("host_a");
    seedEvent({ googleEventIds: { host_a: "g_a" } });
    expect(await removeBookingFromGoogleBeforeDelete("ev_1")).toEqual({ ok: true });
  });
});

describe("an imported Google event", () => {
  it("is never pushed back to Google, and nothing is written to it", async () => {
    connect("host_a");
    seedEvent({ source: "google", bookingPageSlug: null });
    const before = { ...event() };
    await pushBookingToGoogle("ev_1");
    expect(provider.putEvent).not.toHaveBeenCalled();
    expect(event()).toEqual(before);
  });

  it("is never removed from Google: the member's own event survives a cancel or delete", async () => {
    connect("host_a");
    seedEvent({ source: "google", status: "cancelled", googleEventIds: { host_a: "g_members_own" } });
    await pushBookingToGoogle("ev_1");
    await removeBookingFromGoogle("ev_1");
    expect(provider.deleteEvent).not.toHaveBeenCalled();
  });
});
