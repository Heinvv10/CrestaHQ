import { vi } from "vitest";
import { mem } from "@/test/gbp-sync-store";
import type { GcalEvent, GcalSyncResult } from "@/lib/google-calendar/provider/types";

/**
 * Fixtures for the Google Calendar import tests (import.test.ts,
 * import-state.test.ts): the in-memory Firestore (gbp-sync-store — real
 * where/transactions) seeded with one workspace whose three keys are on, and
 * a scripted provider the test file returns from its
 *   vi.mock("@/lib/google-calendar/provider/select", …)
 */

export const SA = "sa_1";
export const AG = "ag_1";
export const U1 = "u1";
export const U2 = "u2";
export const CONN = (uid: string) => `subAccounts/${SA}/private/googleCalendar_${uid}`;

export const provider = {
  syncEvents: vi.fn<(t: string, o: { syncToken: string | null; details: boolean }) => Promise<GcalSyncResult>>(),
  refresh: vi.fn(),
  listEvents: vi.fn(),
  putEvent: vi.fn(async () => {}),
  deleteEvent: vi.fn(async () => {}),
};

export const hours = (h: number) => new Date(Date.now() + h * 3_600_000);
export const iso = (h: number) => hours(h).toISOString();
/** A plain busy Google event `h0`..`h1` hours from now. */
export const gev = (id: string, h0: number, h1: number, over: Partial<GcalEvent> = {}): GcalEvent => ({
  id,
  status: "confirmed",
  summary: "Dentist",
  location: "12 Main Rd",
  start: { dateTime: iso(h0) },
  end: { dateTime: iso(h1) },
  ...over,
});
export const page = (items: GcalEvent[], over: Partial<GcalSyncResult> = {}): GcalSyncResult => ({
  items,
  timeZone: "UTC",
  nextSyncToken: "tok-1",
  truncated: false,
  ...over,
});

export function connectMember(uid: string, over: Record<string, unknown> = {}) {
  mem.seed(`subAccounts/${SA}/subAccountMembers/${uid}`, { uid, status: "active", role: "collaborator" });
  mem.seed(CONN(uid), {
    uid,
    agencyId: AG,
    subAccountId: SA,
    googleEmail: `${uid}@example.com`,
    refreshToken: `r-${uid}`,
    accessToken: `a-${uid}`,
    accessTokenExpiresAt: Date.now() + 3_600_000,
    scopes: [],
    status: "connected",
    connectedAt: new Date(),
    lastError: null,
    lastErrorAt: null,
    importMode: "busy",
    importGeneration: 1,
    ...over,
  });
}

export function resetImport(sub: Record<string, unknown> = {}) {
  mem.clear();
  mem.seed(`subAccounts/${SA}`, {
    agencyId: AG,
    name: "Fixture",
    googleCalendarEnabledByAgency: true,
    calendarImportAllowed: true,
    ...sub,
  });
  mem.seed(`agencies/${AG}`, { ownerUid: "owner" });
  connectMember(U1);
  for (const fn of Object.values(provider)) fn.mockReset();
  provider.syncEvents.mockResolvedValue(page([]));
}

/** The imported docs in the store, by owner. */
export const imported = (uid?: string) =>
  mem.list("events").filter((e) => e.source === "google" && (uid === undefined || e.importOwnerUid === uid));
export const conn = (uid: string) => mem.read(CONN(uid)) as Record<string, unknown>;
