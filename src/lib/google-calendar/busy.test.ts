import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Google busy (G2): filtering, fail open, removed members, the clamped window. */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());
vi.mock("./provider/select", () => ({ getGcalProviderFor: vi.fn(async () => provider) }));

import { SUB, SUB_PATH, state } from "@/test/google-oauth-harness";
import { at, conn, connect, resetGcal, setGate, stubProvider, type StubProvider } from "@/test/gcal-harness";
import { GbpProviderError } from "@/lib/gbp/provider/types";
import { busyFromGoogleEvents, loadGoogleBusy, loadGoogleBusyForPage } from "./busy";
import type { GcalEvent } from "./provider/types";
import type { BookingPage } from "@/types/booking";

let provider: StubProvider;
const oneHour = () => ({
  timeZone: "UTC",
  items: [{ id: "1", start: { dateTime: at(9).toISOString() }, end: { dateTime: at(10).toISOString() } }],
});

beforeEach(() => {
  resetGcal();
  provider = stubProvider();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("busy filtering", () => {
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
  const load = (hostUids = ["host_a"]) => loadGoogleBusy({ subAccountId: SUB, hostUids, from: at(0), to: at(23) });

  it("returns each connected, active host's busy time, tagged by host", async () => {
    connect("host_a");
    connect("host_b");
    provider.listEvents.mockImplementation(async () => oneHour());
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

  it("skips a revoked connection, and a REMOVED member's connection, without calling Google", async () => {
    connect("host_a", { status: "revoked" });
    connect("host_b");
    state.docs.set(`${SUB_PATH}/subAccountMembers/host_b`, { uid: "host_b", status: "removed" });
    expect(await load(["host_a", "host_b"])).toEqual([]);
    expect(provider.listEvents).not.toHaveBeenCalled();
  });

  it("a Google error yields no busy for that host and records lastError", async () => {
    connect("host_a");
    provider.listEvents.mockRejectedValueOnce(new GbpProviderError("transient", { status: 503 }));
    expect(await load()).toEqual([]);
    expect(conn("host_a").lastError).toMatch(/Couldn't reach Google Calendar/);
  });

  it("a malformed uid is skipped without aborting the other hosts", async () => {
    connect("host_b");
    provider.listEvents.mockImplementation(async () => oneHour());
    expect((await load(["bad/uid", "host_b"])).map((b) => b.hostUids[0])).toEqual(["host_b"]);
  });

  it("a host that does not answer within 3s is skipped, its call aborted; the others still count", async () => {
    vi.useFakeTimers();
    connect("host_a");
    connect("host_b");
    let signalA: AbortSignal | undefined;
    provider.listEvents.mockImplementation(async (token: string, _w: unknown, signal: AbortSignal) => {
      if (token !== "a-host_a") return oneHour();
      signalA = signal;
      return new Promise(() => {});
    });
    const pending = load(["host_a", "host_b"]);
    await vi.advanceTimersByTimeAsync(3_001);
    expect((await pending).map((b) => b.hostUids[0])).toEqual(["host_b"]);
    expect(signalA?.aborted).toBe(true);
    expect(conn("host_a").lastError).toMatch(/didn't answer in time/);
  });

  it("a successful read clears a stale lastError — never a push error", async () => {
    connect("host_a", { lastError: "old", lastErrorAt: new Date(), lastPushError: "push failed", lastPushErrorAt: new Date() });
    await load();
    expect(conn("host_a")).toMatchObject({ lastError: null, lastErrorAt: null, lastPushError: "push failed" });
  });
});

describe("loadGoogleBusyForPage", () => {
  const page = { hosts: [{ uid: "host_a", name: "A" }], visibleDays: 7, bufferMinutes: 0 } as unknown as BookingPage;

  it("clamps a caller's from/to to the page's own horizon", async () => {
    connect("host_a");
    const now = at(8);
    await loadGoogleBusyForPage({
      subAccountId: SUB,
      page,
      now,
      fromInstant: new Date(now.getTime() - 400 * 86_400_000),
      toInstant: new Date(now.getTime() + 400 * 86_400_000),
    });
    const [, window] = provider.listEvents.mock.calls[0];
    expect(window).toEqual({ timeMin: now, timeMax: new Date(now.getTime() + 7 * 86_400_000) });
  });

  it("reads the moving event's own hosts too (a host taken off the page)", async () => {
    connect("host_a");
    connect("host_x");
    await loadGoogleBusyForPage({ subAccountId: SUB, page, now: at(8), extraHostUids: ["host_x"] });
    expect(provider.listEvents.mock.calls.map((c) => c[0]).sort()).toEqual(["a-host_a", "a-host_x"]);
  });
});
