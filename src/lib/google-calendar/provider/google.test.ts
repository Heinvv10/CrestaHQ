import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GbpProviderError } from "@/lib/gbp/provider/types";
import { googleGcalProvider as g } from "./google";
import type { GcalEventInput } from "./types";

/** The real provider against a stubbed fetch: request shapes and error mapping. */

let calls: Array<{ url: string; init: RequestInit }> = [];
function stub(...responses: Array<{ status?: number; body?: unknown }>) {
  calls = [];
  const queue = [...responses];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const r = queue.shift() ?? { body: {} };
      return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
}
const INPUT = {
  status: "confirmed",
  summary: "s",
  description: "",
  location: "",
  start: { dateTime: "2026-10-01T10:00:00.000Z" },
  end: { dateTime: "2026-10-01T10:30:00.000Z" },
  extendedProperties: { private: { leadstackEventId: "ev_1" } },
} satisfies GcalEventInput;
const WINDOW = { timeMin: new Date("2026-10-01T00:00:00Z"), timeMax: new Date("2026-10-02T00:00:00Z") };

beforeEach(() => stub());
afterEach(() => vi.unstubAllGlobals());

describe("listEvents", () => {
  it("asks for expanded single events on the primary calendar, and follows nextPageToken", async () => {
    stub(
      { body: { items: [{ id: "1" }], timeZone: "Africa/Johannesburg", nextPageToken: "p2" } },
      { body: { items: [{ id: "2" }] } },
    );
    const list = await g.listEvents("tok", WINDOW);
    expect(list).toEqual({ items: [{ id: "1" }, { id: "2" }], timeZone: "Africa/Johannesburg" });
    const first = new URL(calls[0].url);
    expect(first.origin + first.pathname).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect(Object.fromEntries(first.searchParams)).toEqual({
      timeMin: WINDOW.timeMin.toISOString(),
      timeMax: WINDOW.timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });
    expect(new URL(calls[1].url).searchParams.get("pageToken")).toBe("p2");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("refuses a window that still has pages after MAX_PAGES (busy would be missing)", async () => {
    stub(...Array.from({ length: 11 }, (_, i) => ({ body: { items: [], nextPageToken: `p${i}` } })));
    await expect(g.listEvents("tok", WINDOW)).rejects.toMatchObject({ kind: "malformed" });
    expect(calls).toHaveLength(10);
  });
});

describe("putEvent", () => {
  it("inserts under our id", async () => {
    await g.putEvent("tok", "lsabc123", INPUT);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ id: "lsabc123", ...INPUT });
  });

  it("on 409 (the id exists) overwrites it with a PATCH to that id", async () => {
    stub({ status: 409, body: { error: { code: 409 } } }, { body: { id: "lsabc123" } });
    await g.putEvent("tok", "lsabc123", INPUT);
    expect(calls[1].init.method).toBe("PATCH");
    expect(calls[1].url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/lsabc123");
  });

  it("refuses an id that could smuggle a path", async () => {
    await expect(g.putEvent("tok", "../x", INPUT)).rejects.toBeInstanceOf(GbpProviderError);
    expect(calls).toHaveLength(0);
  });
});

describe("deleteEvent", () => {
  it("maps 410 Gone and 404 to not_found", async () => {
    stub({ status: 410, body: {} }, { status: 404, body: {} });
    await expect(g.deleteEvent("tok", "lsabc123")).rejects.toMatchObject({ kind: "not_found" });
    await expect(g.deleteEvent("tok", "lsabc123")).rejects.toMatchObject({ kind: "not_found" });
    expect(calls[0].init.method).toBe("DELETE");
  });
});
