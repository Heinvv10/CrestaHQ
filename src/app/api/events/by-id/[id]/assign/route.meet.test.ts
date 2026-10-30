import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { GcalEventInput } from "@/lib/google-calendar/provider/types";

/**
 * Reassigning a Google Meet booking end to end: the real assign route and
 * the real Google push over an in-memory Firestore; only Google is a stub.
 * The booker was sent a Meet link; the new host gets the SAME link on their
 * copy, no second room is made, and the old host's copy is removed.
 */

const mem = createMemoryFirestore();
const MEET_LINK = "https://meet.google.com/abc-defg-hij";
const google = vi.hoisted(() => ({
  putEvent: vi.fn(async (_t: string, _id: string, input: { conferenceData?: unknown }) => ({
    created: true,
    meetUrl: input.conferenceData ? "https://meet.google.com/new-room-zzz" : null,
  })),
  deleteEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u1", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" }),
}));
vi.mock("@/lib/google-calendar/provider/select", () => ({
  getGcalProviderFor: async () => ({ ...google, refresh: vi.fn() }),
}));

const { POST } = await import("./route");

const ts = (iso: string) => {
  const d = new Date(iso);
  return { toDate: () => d, toMillis: () => d.getTime() };
};
const sentTo = (uid: string) =>
  google.putEvent.mock.calls.find(([token]) => token === `tok-${uid}`)?.[2] as GcalEventInput | undefined;

beforeEach(() => {
  mem.clear();
  google.putEvent.mockClear();
  google.deleteEvent.mockClear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", googleCalendarEnabledByAgency: true });
  mem.seed("subAccounts/sa1/bookingPages/p", {
    slug: "p",
    hosts: [{ uid: "a", name: "A" }, { uid: "b", name: "B" }],
    location: { type: "google_meet", value: null },
    googleMeet: true,
  });
  for (const uid of ["a", "b"]) {
    mem.seed(`subAccounts/sa1/subAccountMembers/${uid}`, { uid, status: "active", displayName: uid });
    mem.seed(`subAccounts/sa1/private/googleCalendar_${uid}`, {
      uid,
      status: "connected",
      accessToken: `tok-${uid}`,
      refreshToken: `r-${uid}`,
      accessTokenExpiresAt: Date.now() + 3600_000,
    });
  }
  mem.seed("events/ev", {
    subAccountId: "sa1",
    agencyId: "ag1",
    source: "booking_page",
    bookingPageSlug: "p",
    status: "scheduled",
    title: "Intro",
    contactId: null,
    assignedToUid: "a",
    meetingUrl: MEET_LINK,
    location: "Google Meet video call",
    googleEventIds: { a: "ls-old-a" },
    startAt: ts("2027-09-14T09:00:00Z"),
    endAt: ts("2027-09-14T09:30:00Z"),
  });
});

describe("reassigning a Google Meet booking", () => {
  it("moves the copy to the new host with the same link and makes no new room", async () => {
    const res = await POST(
      new Request("http://x/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignedToUid: "b" }),
      }),
      { params: Promise.resolve({ id: "ev" }) },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(google.deleteEvent).toHaveBeenCalledWith("tok-a", "ls-old-a", expect.any(AbortSignal));
    expect(sentTo("b")?.conferenceData).toBeUndefined();
    expect(sentTo("b")?.location).toBe(MEET_LINK);
    expect(mem.read("events/ev")).toMatchObject({ assignedToUid: "b", meetingUrl: MEET_LINK });
    expect(Object.keys((mem.read("events/ev") as { googleEventIds: object }).googleEventIds)).toEqual(["b"]);
  });
});
