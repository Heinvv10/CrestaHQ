import "server-only";

import crypto from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { isLongEvent } from "@/lib/booking/long-event";
import { GLOBAL_TERRITORY_ID } from "@/types/tenancy";
import { IMPORTED_EVENT_SOURCE } from "@/types/events";
import { instant, isBusy } from "./busy";
import type { GcalEvent } from "./provider/types";

/**
 * Google event → imported `events` doc, for the calendar import (import.ts).
 * Pure apart from hashing. The privacy rules live here:
 *   - only what blocks the member's time is imported — the SAME rule as
 *     Google busy for booking pages (`isBusy`): cancelled, Free
 *     (transparent), declined and LeadStack's own pushed copies are not;
 *   - all-day events are imported only when they are Busy (Google makes an
 *     all-day event Free unless the member chose Busy), midnight to midnight
 *     in the calendar's zone, as busy.ts reads them;
 *   - "busy" mode stores the time only (title "Busy"); "details" adds the
 *     title and place, never for a Google-private event; descriptions,
 *     guests, links and attachments are never stored in either mode.
 */

export const BUSY_TITLE = "Busy";
/** Google's own non-appointment kinds. */
const SKIPPED_EVENT_TYPES = new Set(["workingLocation", "birthday"]);
const TEXT_MAX = 200;

export type ImportDetail = "busy" | "details";

/**
 * Deterministic, so a re-run never duplicates; scoped to the workspace and
 * member, because one Google calendar can be imported into several.
 */
export function importedEventDocId(subAccountId: string, uid: string, googleEventId: string): string {
  const h = crypto.createHash("sha256").update(`${subAccountId}\n${uid}\n${googleEventId}`).digest("hex");
  return `gcal_${h.slice(0, 40)}`;
}

export interface ImportedFields {
  title: string;
  location: string;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
}

/** `null`: no id to key on. `remove`: must not be (or stay) imported. */
export function mapGoogleEvent(
  ev: GcalEvent,
  detail: ImportDetail,
  calendarTz: string,
  window: { timeMin: Date; timeMax: Date },
): { kind: "remove" } | { kind: "upsert"; fields: ImportedFields } | null {
  if (!ev.id) return null;
  if (!isBusy(ev)) return { kind: "remove" };
  if (ev.eventType && SKIPPED_EVENT_TYPES.has(ev.eventType)) return { kind: "remove" };
  const startAt = instant(ev.start, calendarTz);
  const endAt = instant(ev.end, calendarTz);
  if (!startAt || !endAt || endAt <= startAt) return { kind: "remove" };
  // An incremental walk is not windowed by Google; apply ours.
  if (endAt <= window.timeMin || startAt >= window.timeMax) return { kind: "remove" };
  const shared = detail === "details" && ev.visibility !== "private" && ev.visibility !== "confidential";
  return {
    kind: "upsert",
    fields: {
      title: shared ? (ev.summary?.trim() || "(No title)").slice(0, TEXT_MAX) : BUSY_TITLE,
      location: shared ? (ev.location?.trim() ?? "").slice(0, TEXT_MAX) : "",
      startAt,
      endAt,
      allDay: !ev.start?.dateTime && !!ev.start?.date,
    },
  };
}

/**
 * The stored doc, minus createdAt. Never `assignedToUid`, `hostUids`,
 * `mode`, `publicTokenHash` or `bookingPageSlug`: those make an event a
 * booking, an API record or a public page. Territory "global" so every
 * member sees the owner is busy; `isLong` so a multi-day block is found by
 * the availability long-event query.
 */
export function importedEventDoc(
  fields: ImportedFields,
  ctx: { agencyId: string; subAccountId: string; uid: string; detail: ImportDetail },
): Record<string, unknown> {
  return {
    title: fields.title,
    location: fields.location,
    notes: "",
    contactId: null,
    meetingUrl: null,
    startAt: Timestamp.fromDate(fields.startAt),
    endAt: Timestamp.fromDate(fields.endAt),
    allDay: fields.allDay,
    isLong: isLongEvent(fields.startAt, fields.endAt),
    status: "scheduled",
    source: IMPORTED_EVENT_SOURCE,
    importOwnerUid: ctx.uid,
    importMode: ctx.detail,
    territoryId: GLOBAL_TERRITORY_ID,
    agencyId: ctx.agencyId,
    subAccountId: ctx.subAccountId,
    createdByUid: ctx.uid,
  };
}

function millis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  const t = v as { toMillis?: () => number; toDate?: () => Date } | null;
  if (typeof t?.toMillis === "function") return t.toMillis();
  const d = t?.toDate?.();
  return d instanceof Date ? d.getTime() : null;
}

/** True when the stored doc already says what `next` says: no write needed. */
export function sameImport(stored: Record<string, unknown> | undefined, next: Record<string, unknown>): boolean {
  if (!stored) return false;
  for (const [k, v] of Object.entries(next)) {
    if (k === "startAt" || k === "endAt") {
      if (millis(stored[k]) !== millis(v)) return false;
    } else if (stored[k] !== v) return false;
  }
  return true;
}
