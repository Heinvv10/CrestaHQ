import type { AppointmentTab } from "@/lib/calendar/appointment-filters";

/**
 * What the appointments list must admit about the events it did NOT load
 * (see subscribeToAppointments). Upcoming only ever shows future events, so
 * a truncated past half cannot change it; Cancelled and All span both
 * halves, so either being truncated makes them partial.
 */
export interface AppointmentsWindow {
  upcomingTruncated: boolean;
  pastTruncated: boolean;
}

export function tabIsPartial(tab: AppointmentTab, w: AppointmentsWindow): boolean {
  if (tab === "upcoming") return w.upcomingTruncated;
  return w.upcomingTruncated || w.pastTruncated;
}

/** Show the "older appointments are not loaded / Fetch older appointments" notice. */
export function showOlderNotice(tab: AppointmentTab, w: AppointmentsWindow): boolean {
  return tab !== "upcoming" && w.pastTruncated;
}
