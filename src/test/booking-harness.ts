import { vi } from "vitest";
import { createMemoryFirestore } from "./memory-firestore";
import type { BookingPage } from "@/types/booking";

/**
 * Seam tests for the booking routes: real route → real resolver → real slot
 * rules, over an in-memory Firestore. Only side effects (email, reminders,
 * triggers, contact reconcile) are stubbed, in the test file:
 *
 *   const h = () => import("@/test/booking-harness");
 *   vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
 *   …same for resend / lifecycle / contact-reconcile
 *
 * No app imports here: the admin mock factory loads this module.
 *
 * Clock: Monday 2026-09-14 06:00 UTC. Pages are UTC, open 09:00–12:00 Mon,
 * 30-min slots, no minimum notice — so `at("09:00")` is always bookable.
 */

export const mem = createMemoryFirestore();
export const SA = "sa1";
export const NOW = new Date("2026-09-14T06:00:00Z");
export const at = (hhmm: string) => new Date(`2026-09-14T${hhmm}:00Z`);

/** Factories for the test file's `vi.mock` calls (see the header). */
export const bookingMocks = {
  admin: () => ({ getAdminDb: () => mem.db }),
  resend: () => ({
    emailIsConfigured: () => false,
    sendEmail: async () => undefined,
    tenantFrom: () => "x@example.com",
  }),
  lifecycle: () => ({
    emitBookingWebhook: async () => undefined,
    fireBookingTrigger: async () => undefined,
    recordBookingActivity: async () => undefined,
    schedulePaymentAutoExpire: async () => undefined,
    scheduleEventReminders: async () => undefined,
  }),
  reconcile: () => ({
    reconcileBookingContact: async () => ({ id: "c1", created: false }),
  }),
};

export function resetBookingHarness(): void {
  process.env.AUTOMATIONS_TOKEN_SECRET = "booking-harness-secret-0123456789";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mem.clear();
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture" });
}

export function seedPage(slug: string, over: Partial<BookingPage> = {}): BookingPage {
  const page = {
    id: slug,
    slug,
    name: slug,
    description: "",
    status: "published",
    durationMinutes: 30,
    bufferMinutes: 0,
    workingHours: [{ dayOfWeek: 1, startMinute: 540, endMinute: 720 }],
    timezone: "UTC",
    visibleDays: 14,
    minNoticeHours: 0,
    maxPerDay: null,
    intakeFields: [],
    logoUrl: null,
    accentColor: null,
    confirmationMessage: "",
    remindersEnabled: false,
    reminderOffsetsMinutes: [],
    payment: null,
    territoryId: "global",
    defaultTerritoryId: null,
    agencyId: "ag1",
    subAccountId: SA,
    createdByUid: "u1",
    createdAt: null,
    updatedAt: null,
    ...over,
  } as BookingPage;
  mem.seed(`subAccounts/${SA}/bookingPages/${slug}`, { ...page });
  return page;
}

/** An occupying event, stored the way Firestore returns it (Timestamps). */
export function seedEvent(
  id: string,
  start: string,
  end: string,
  over: Record<string, unknown> = {},
): void {
  const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });
  mem.seed(`events/${id}`, {
    id,
    subAccountId: SA,
    agencyId: "ag1",
    status: "scheduled",
    startAt: ts(at(start)),
    endAt: ts(at(end)),
    assignedToUid: null,
    contactId: null,
    ...over,
  });
}

let ip = 0;
export function post(body: unknown): Request {
  return new Request("http://x/api", {
    method: "POST",
    // A fresh IP per request so the per-IP booking cap never trips.
    headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${++ip}` },
    body: JSON.stringify(body),
  });
}

export const slot = (start: string, end: string) => ({
  startAt: at(start).toISOString(),
  endAt: at(end).toISOString(),
});
