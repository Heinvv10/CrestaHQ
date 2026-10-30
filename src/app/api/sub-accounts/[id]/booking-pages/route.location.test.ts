import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { defaultBookingPageFormData } from "@/lib/booking/defaults";

/**
 * A booking page's location through the real create / update / duplicate
 * routes, validator and host resolution. Google Meet is made on a host's own
 * Google Calendar, so it is refused unless Calendar sync is on for the
 * sub-account and every host on the page has a working connection.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "u1", agencyId: "ag1" }),
  requireSubAccountMember: async () => ({ uid: "u1", agencyId: "ag1" }),
}));

const { POST } = await import("./route");
const { PATCH } = await import("./[slug]/route");
const { POST: DUPLICATE } = await import("./[slug]/duplicate/route");

const MEET = { type: "google_meet", value: null };
const body = (extra: object) => ({
  ...defaultBookingPageFormData("loc", "UTC"),
  name: "Loc",
  ...extra,
});
const req = (method: string, b: unknown) =>
  new Request("http://x/api", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const create = (extra: object) => POST(req("POST", body(extra)), { params: Promise.resolve({ id: "sa1" }) });
const update = (extra: object) =>
  PATCH(req("PATCH", body(extra)), { params: Promise.resolve({ id: "sa1", slug: "loc" }) });
const stored = () => mem.read("subAccounts/sa1/bookingPages/loc") as Record<string, unknown> | undefined;
const error = async (res: Response) => ((await res.json()) as { error?: string }).error ?? "";

const member = (uid: string) =>
  mem.seed(`subAccounts/sa1/subAccountMembers/${uid}`, { uid, status: "active", displayName: uid.toUpperCase() });
const connect = (uid: string, status = "connected") =>
  mem.seed(`subAccounts/sa1/private/googleCalendar_${uid}`, { uid, status });
const gate = (on: boolean) => mem.seed("subAccounts/sa1", { agencyId: "ag1", googleCalendarEnabledByAgency: on });
const HOSTS = [{ uid: "a", name: "x" }, { uid: "b", name: "y" }];

beforeEach(() => {
  mem.clear();
  gate(true);
  member("a");
  member("b");
  connect("a");
  connect("b");
});

describe("location types", () => {
  it("refuses an unknown type, and a type smuggled as a string", async () => {
    expect((await create({ location: { type: "teleport", value: null } })).status).toBe(400);
    expect((await create({ location: "in_person" })).status).toBe(400);
    expect(stored()).toBeUndefined();
  });

  it("in person: needs a plain one-line address of at most 300 characters", async () => {
    expect((await create({ location: { type: "in_person", value: "" } })).status).toBe(400);
    expect((await create({ location: { type: "in_person", value: "x".repeat(301) } })).status).toBe(400);
    expect((await create({ location: { type: "in_person", value: '1 Main"><img src=x onerror=alert(1)>' } })).status).toBe(400);
    expect((await create({ location: { type: "in_person", value: "1 Main Rd\nSandton" } })).status).toBe(400);
    expect(stored()).toBeUndefined();
    expect((await create({ location: { type: "in_person", value: "  12 Main Rd, Sandton  " } })).status).toBe(200);
    expect(stored()).toMatchObject({ location: { type: "in_person", value: "12 Main Rd, Sandton" }, googleMeet: false });
  });

  it("they call: needs a phone number; we call: stores no value", async () => {
    expect((await create({ location: { type: "they_call", value: "call me" } })).status).toBe(400);
    expect((await create({ location: { type: "we_call", value: "ignored <b>" } })).status).toBe(200);
    expect(stored()).toMatchObject({ location: { type: "we_call", value: null } });
  });

  it("a video link needs the meeting URL; a phone page drops a stray one", async () => {
    expect((await create({ location: { type: "video_link", value: null } })).status).toBe(400);
    expect((await create({ location: { type: "we_call", value: null }, meetingUrl: "https://zoom.example/x" })).status).toBe(200);
    expect(stored()).toMatchObject({ meetingUrl: null });
  });

  it("googleMeet follows the location, never the body's own flag", async () => {
    expect((await create({ location: { type: "we_call", value: null }, googleMeet: true })).status).toBe(200);
    expect(stored()).toMatchObject({ googleMeet: false });
  });
});

describe("Google Meet", () => {
  it("saves when Calendar sync is on and every host is connected", async () => {
    const res = await create({ hosts: HOSTS, calendarType: "round_robin", location: MEET });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(stored()).toMatchObject({ googleMeet: true, location: MEET });
  });

  it("is refused while the agency gate is off", async () => {
    gate(false);
    const res = await create({ hosts: HOSTS, calendarType: "round_robin", location: MEET });
    expect(res.status).toBe(400);
    expect(await error(res)).toMatch(/Calendar sync/);
    expect(stored()).toBeUndefined();
  });

  it("is refused on a page with no hosts (no one's calendar to make the room on)", async () => {
    const res = await create({ location: MEET });
    expect(res.status).toBe(400);
    expect(await error(res)).toMatch(/needs a host/);
  });

  it("is refused while any host is not connected, naming them — revoked counts as not connected", async () => {
    connect("b", "revoked");
    const res = await create({ hosts: HOSTS, calendarType: "round_robin", location: MEET });
    expect(res.status).toBe(400);
    // Names are re-snapshotted from live membership (displayName).
    expect(await error(res)).toMatch(/Not connected: B\./);
  });

  it("an edit is checked the same way", async () => {
    expect((await create({ hosts: HOSTS, calendarType: "round_robin" })).status).toBe(200);
    mem.seed("subAccounts/sa1/private/googleCalendar_a", { uid: "a", status: "revoked" });
    const res = await update({ hosts: HOSTS, calendarType: "round_robin", location: MEET });
    expect(res.status).toBe(400);
    expect(stored()).toMatchObject({ location: null, googleMeet: false });
  });

  it("a duplicate whose hosts are no longer connected is copied without Meet, with a warning", async () => {
    expect((await create({ hosts: HOSTS, calendarType: "round_robin", location: MEET, meetingUrl: "https://zoom.example/f" })).status).toBe(200);
    connect("a", "revoked");
    const res = await DUPLICATE(req("POST", {}), { params: Promise.resolve({ id: "sa1", slug: "loc" }) });
    const out = (await res.json()) as { slug: string; warning: string | null };
    expect(res.status).toBe(200);
    expect(out.warning).toMatch(/Google Meet was removed/);
    expect(mem.read(`subAccounts/sa1/bookingPages/${out.slug}`)).toMatchObject({
      location: null,
      googleMeet: false,
      meetingUrl: "https://zoom.example/f",
    });
  });
});
