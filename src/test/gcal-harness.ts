import { vi } from "vitest";
import { SUB, SUB_PATH, resetHarness, state } from "@/test/google-oauth-harness";
import type { GcalProvider } from "@/lib/google-calendar/provider/types";
import type { GoogleCalendarConnection } from "@/lib/google-calendar/connection";

/**
 * Shared fixtures for the Google Calendar library tests (busy / push /
 * connection). Firestore is google-oauth-harness (recording, real merge
 * semantics); the provider is a scripted stub the test file returns from its
 * `vi.mock("@/lib/google-calendar/provider/select")`.
 */

export const CAL = (uid: string) => `subAccounts/${SUB}/private/googleCalendar_${uid}`;
export const EVENT = "events/ev_1";
export const PAGE = `subAccounts/${SUB}/bookingPages/p`;

export type StubProvider = { [K in keyof GcalProvider]: ReturnType<typeof vi.fn> };

export function stubProvider(): StubProvider {
  return {
    authorizeUrl: vi.fn(),
    exchangeCode: vi.fn(),
    refresh: vi.fn(async () => ({ accessToken: "fresh", refreshToken: null, expiresAt: Date.now() + 3600_000, scopes: [] })),
    userEmail: vi.fn(),
    listEvents: vi.fn(async () => ({ items: [], timeZone: "UTC" })),
    putEvent: vi.fn(async () => ({ created: true, meetUrl: null })),
    deleteEvent: vi.fn(async () => {}),
  };
}

export function connect(uid: string, over: Partial<GoogleCalendarConnection> = {}) {
  state.docs.set(`${SUB_PATH}/subAccountMembers/${uid}`, { uid, status: "active" });
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

export const conn = (uid: string) => state.docs.get(CAL(uid)) as unknown as GoogleCalendarConnection;
export const setGate = (on: boolean) =>
  state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleCalendarEnabledByAgency: on });

export const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 1, h, m));
export const ts = (d: Date) => ({ toDate: () => d });

/** A booking-page event on page "p", whose hosts are `pageHosts`. */
export function seedEvent(over: Record<string, unknown> = {}, pageHosts = ["host_a", "host_b", "host_c"]) {
  state.docs.set(PAGE, { slug: "p", hosts: pageHosts.map((uid) => ({ uid, name: uid.toUpperCase() })) });
  state.docs.set(EVENT, {
    id: "ev_1",
    title: "Consult — Ada",
    notes: "Q: hi",
    meetingUrl: "https://meet.example/x",
    location: "",
    agencyId: "ag_1",
    subAccountId: SUB,
    bookingPageSlug: "p",
    status: "scheduled",
    startAt: ts(at(10)),
    endAt: ts(at(10, 30)),
    assignedToUid: "host_a",
    ...over,
  });
}
export const event = () => state.docs.get(EVENT) as Record<string, unknown>;

export function resetGcal(): void {
  resetHarness();
  setGate(true);
}
