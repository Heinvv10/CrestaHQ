import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Google Calendar library (SP3 G2–G4): token refresh, busy loading (and
 * its fail-open contract), and pushing bookings. Firestore is the recording
 * harness; the provider is a scripted stub returned by the real selection
 * seam's module, so every call Google would receive is visible.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/google-oauth-harness")).adminMock(),
);
vi.mock("./provider/select", () => ({ getGcalProviderFor: vi.fn(async () => provider) }));

import { SUB, SUB_PATH, resetHarness, state } from "@/test/google-oauth-harness";
import { GbpProviderError } from "@/lib/gbp/provider/types";
import { busyFromGoogleEvents, loadGoogleBusy } from "./busy";
import { withGoogleToken, type GoogleCalendarConnection } from "./connection";
import { pushBookingToGoogle } from "./push";
import type { GcalEvent, GcalProvider } from "./provider/types";

const CAL = (uid: string) => `subAccounts/${SUB}/private/googleCalendar_${uid}`;
const EVENT = "events/ev_1";

let provider: { [K in keyof GcalProvider]: ReturnType<typeof vi.fn> };

function stubProvider() {
  let n = 0;
  provider = {
    authorizeUrl: vi.fn(),
    exchangeCode: vi.fn(),
    refresh: vi.fn(async () => ({ accessToken: "fresh", refreshToken: null, expiresAt: Date.now() + 3600_000, scopes: [] })),
    userEmail: vi.fn(),
    listEvents: vi.fn(async () => ({ items: [], timeZone: "UTC" })),
    insertEvent: vi.fn(async () => `g${++n}`),
    patchEvent: vi.fn(async () => {}),
    deleteEvent: vi.fn(async () => {}),
  };
}

function connect(uid: string, over: Partial<GoogleCalendarConnection> = {}) {
  state.docs.set(CAL(uid), {
    uid,
    agencyId: "ag_1",
    subAccountId: SUB,
    googleEmail: `${uid}@example.com`,
    refreshToken: `r-${uid}`,
    accessToken: `a-${uid}`,
    accessTokenExpiresAt: Date.now() + 3600_000,
    scopes: [],
    status: "connected",
    connectedAt: new Date(),
    lastError: null,
    lastErrorAt: null,
    ...over,
  });
}
const conn = (uid: string) => state.docs.get(CAL(uid)) as unknown as GoogleCalendarConnection;
const setGate = (on: boolean) =>
  state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleCalendarEnabledByAgency: on });

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 1, h, m));
const ts = (d: Date) => ({ toDate: () => d });
function seedEvent(over: Record<string, unknown> = {}) {
  state.docs.set(EVENT, {
    id: "ev_1",
    title: "Consult — Ada",
    notes: "Q: hi",
    meetingUrl: "https://meet.example/x",
    location: "",
    agencyId: "ag_1",
    subAccountId: SUB,
    status: "scheduled",
    startAt: ts(at(10)),
    endAt: ts(at(10, 30)),
    assignedToUid: "host_a",
    ...over,
  });
}
const event = () => state.docs.get(EVENT) as Record<string, unknown>;

beforeEach(() => {
  resetHarness();
  setGate(true);
  stubProvider();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("token refresh (G4)", () => {
  it("uses the cached access token while more than a minute is left", async () => {
    connect("host_a");
    expect(await withGoogleToken(conn("host_a"), provider as unknown as GcalProvider, async (t) => t)).toBe("a-host_a");
    expect(provider.refresh).not.toHaveBeenCalled();
  });

  it("refreshes under a minute left, storing the new token and a rotated refresh token", async () => {
    connect("host_a", { accessTokenExpiresAt: Date.now() + 30_000 });
    provider.refresh.mockResolvedValueOnce({ accessToken: "fresh", refreshToken: "rotated", expiresAt: 123, scopes: [] });
    expect(await withGoogleToken(conn("host_a"), provider as unknown as GcalProvider, async (t) => t)).toBe("fresh");
    expect(state.docs.get(CAL("host_a"))).toMatchObject({ accessToken: "fresh", refreshToken: "rotated", accessTokenExpiresAt: 123 });
  });

  it("invalid_grant marks the connection revoked with a lastError, and rethrows", async () => {
    connect("host_a", { accessTokenExpiresAt: 0 });
    provider.refresh.mockRejectedValueOnce(new GbpProviderError("revoked", { status: 400 }));
    await expect(withGoogleToken(conn("host_a"), provider as unknown as GcalProvider, async (t) => t)).rejects.toThrow();
    expect(state.docs.get(CAL("host_a"))).toMatchObject({ status: "revoked", lastError: expect.stringContaining("Reconnect") });
  });

  it("a 401 on a still-cached token earns exactly one forced refresh and a retry", async () => {
    connect("host_a");
    const fn = vi.fn(async (t: string) => {
      if (t === "a-host_a") throw new GbpProviderError("auth_expired", { status: 401 });
      return t;
    });
    expect(await withGoogleToken(conn("host_a"), provider as unknown as GcalProvider, fn)).toBe("fresh");
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("busy filtering (G2)", () => {
  const e = (over: Partial<GcalEvent>): GcalEvent => ({
    id: "x",
    start: { dateTime: "2026-10-01T10:00:00Z" },
    end: { dateTime: "2026-10-01T11:00:00Z" },
    ...over,
  });

  it("keeps opaque timed events and skips transparent, cancelled, declined and LeadStack's own", () => {
    const busy = busyFromGoogleEvents(
      {
        timeZone: "UTC",
        items: [
          e({ id: "busy" }),
          e({ transparency: "transparent" }),
          e({ status: "cancelled" }),
          e({ attendees: [{ self: true, responseStatus: "declined" }] }),
          e({ extendedProperties: { private: { leadstackEventId: "ev_9" } } }),
        ],
      },
      "host_a",
    );
    expect(busy).toEqual([{ startAt: at(10), endAt: at(11), hostUids: ["host_a"] }]);
  });

  it("reads an all-day event as midnight-to-midnight in the calendar's timezone", () => {
    const [b] = busyFromGoogleEvents(
      { timeZone: "Africa/Johannesburg", items: [e({ start: { date: "2026-10-01" }, end: { date: "2026-10-02" } })] },
      "host_a",
    );
    expect(b.startAt.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(b.endAt.toISOString()).toBe("2026-10-01T22:00:00.000Z");
  });
});

describe("loadGoogleBusy — fail open", () => {
  const load = (hostUids = ["host_a"]) =>
    loadGoogleBusy({ subAccountId: SUB, hostUids, from: at(0), to: at(23) });

  it("returns each connected host's busy time, tagged by host", async () => {
    connect("host_a");
    connect("host_b");
    provider.listEvents.mockImplementation(async () => ({
      timeZone: "UTC",
      items: [{ id: "1", start: { dateTime: at(9).toISOString() }, end: { dateTime: at(10).toISOString() } }],
    }));
    const busy = await load(["host_a", "host_b", "host_c"]);
    expect(busy.map((b) => b.hostUids).sort()).toEqual([["host_a"], ["host_b"]]);
    expect(busy[0]).toMatchObject({ startAt: at(9), endAt: at(10) });
  });

  it("reads nothing with the gate off or with no hosts (hostless page)", async () => {
    connect("host_a");
    setGate(false);
    expect(await load()).toEqual([]);
    setGate(true);
    expect(await load([])).toEqual([]);
    expect(provider.listEvents).not.toHaveBeenCalled();
  });

  it("skips a revoked connection without calling Google", async () => {
    connect("host_a", { status: "revoked" });
    expect(await load()).toEqual([]);
    expect(provider.listEvents).not.toHaveBeenCalled();
  });

  it("a Google error yields no busy for that host and records lastError", async () => {
    connect("host_a");
    provider.listEvents.mockRejectedValueOnce(new GbpProviderError("transient", { status: 503 }));
    expect(await load()).toEqual([]);
    expect(conn("host_a").lastError).toMatch(/Couldn't reach Google Calendar/);
  });

  it("a host that does not answer within 3s is skipped (the others still count)", async () => {
    vi.useFakeTimers();
    connect("host_a");
    connect("host_b");
    provider.listEvents.mockImplementation(async (token: string) =>
      token === "a-host_a"
        ? new Promise(() => {})
        : { timeZone: "UTC", items: [{ id: "1", start: { dateTime: at(9).toISOString() }, end: { dateTime: at(10).toISOString() } }] },
    );
    const pending = load(["host_a", "host_b"]);
    await vi.advanceTimersByTimeAsync(3_001);
    const busy = await pending;
    expect(busy.map((b) => b.hostUids[0])).toEqual(["host_b"]);
    expect(conn("host_a").lastError).toMatch(/didn't answer in time/);
  });

  it("a successful read clears a stale lastError", async () => {
    connect("host_a", { lastError: "old", lastErrorAt: new Date() });
    await load();
    expect(conn("host_a")).toMatchObject({ lastError: null, lastErrorAt: null });
  });
});

describe("pushBookingToGoogle (G3)", () => {
  it("inserts into the host's primary calendar, tagged with leadstackEventId, and stores the id", async () => {
    connect("host_a");
    seedEvent();
    await pushBookingToGoogle("ev_1");
    expect(provider.insertEvent).toHaveBeenCalledWith("a-host_a", {
      summary: "Consult — Ada",
      description: "Q: hi",
      location: "https://meet.example/x",
      start: { dateTime: at(10).toISOString() },
      end: { dateTime: at(10, 30).toISOString() },
      extendedProperties: { private: { leadstackEventId: "ev_1" } },
    });
    expect(event()).toMatchObject({ googleEventIds: { host_a: "g1" }, googleSyncError: null });
  });

  it("patches the same Google event on reschedule, and re-inserts one the member deleted", async () => {
    connect("host_a");
    seedEvent({ googleEventIds: { host_a: "g_old" }, startAt: ts(at(14)), endAt: ts(at(14, 30)) });
    await pushBookingToGoogle("ev_1");
    expect(provider.patchEvent).toHaveBeenCalledWith("a-host_a", "g_old", expect.objectContaining({ start: { dateTime: at(14).toISOString() } }));
    expect(provider.insertEvent).not.toHaveBeenCalled();

    provider.patchEvent.mockRejectedValueOnce(new GbpProviderError("not_found", { status: 404 }));
    await pushBookingToGoogle("ev_1");
    expect(event().googleEventIds).toEqual({ host_a: "g1" });
  });

  it("deletes the Google copy on cancel and clears the id — even with the gate off", async () => {
    connect("host_a");
    setGate(false);
    seedEvent({ status: "cancelled", googleEventIds: { host_a: "g_old" } });
    await pushBookingToGoogle("ev_1");
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_a", "g_old");
    expect(event().googleEventIds).toEqual({});
  });

  it("treats an already-deleted Google event as removed", async () => {
    connect("host_a");
    seedEvent({ status: "cancelled", googleEventIds: { host_a: "g_old" } });
    provider.deleteEvent.mockRejectedValueOnce(new GbpProviderError("not_found", { status: 404 }));
    await pushBookingToGoogle("ev_1");
    expect(event()).toMatchObject({ googleEventIds: {}, googleSyncError: null });
  });

  it("leaves completed / no-show meetings alone, and writes nothing while the gate is off", async () => {
    connect("host_a");
    seedEvent({ status: "completed", googleEventIds: { host_a: "g_old" } });
    await pushBookingToGoogle("ev_1");
    seedEvent();
    setGate(false);
    await pushBookingToGoogle("ev_1");
    expect(provider.insertEvent).not.toHaveBeenCalled();
    expect(provider.deleteEvent).not.toHaveBeenCalled();
    expect(state.writes.filter((w) => w.path === EVENT)).toEqual([]);
  });

  it("pushes to every host of a collective event, and deletes for a host taken off it", async () => {
    connect("host_a");
    connect("host_b");
    connect("host_c");
    seedEvent({ hostUids: ["host_a", "host_b"], googleEventIds: { host_c: "g_c" } });
    await pushBookingToGoogle("ev_1");
    expect(provider.insertEvent).toHaveBeenCalledTimes(2);
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_c", "g_c");
    expect(Object.keys(event().googleEventIds as object).sort()).toEqual(["host_a", "host_b"]);
  });

  it("a reassign moves the Google copy: deleted for the old host, inserted for the new", async () => {
    connect("host_a");
    connect("host_b");
    seedEvent({ assignedToUid: "host_b", googleEventIds: { host_a: "g_a" } });
    await pushBookingToGoogle("ev_1");
    expect(provider.deleteEvent).toHaveBeenCalledWith("a-host_a", "g_a");
    expect(provider.insertEvent).toHaveBeenCalledWith("a-host_b", expect.anything());
    expect(event().googleEventIds).toEqual({ host_b: "g1" });
  });

  it("skips a host with no connection; a failure lands on the event and the connection, never thrown", async () => {
    connect("host_a");
    seedEvent({ hostUids: ["host_a", "host_x"] });
    provider.insertEvent.mockRejectedValueOnce(new GbpProviderError("rate_limited", { status: 429 }));
    await expect(pushBookingToGoogle("ev_1")).resolves.toBeUndefined();
    expect(event()).toMatchObject({ googleEventIds: {}, googleSyncError: { message: expect.stringMatching(/rate-limiting/) } });
    expect(conn("host_a").lastError).toMatch(/rate-limiting/);
  });
});
