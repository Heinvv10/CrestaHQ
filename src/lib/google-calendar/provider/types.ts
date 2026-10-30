import type { GoogleTokens } from "@/lib/google/oauth";

/**
 * The Google Calendar provider boundary. Every Calendar HTTP call goes through
 * an implementation of {@link GcalProvider} — the real one (`google.ts`) or the
 * fenced fake (`fake.ts`). Callers obtain one ONLY via
 * `getGcalProviderFor(subAccountId, uid)` in `select.ts`.
 *
 * Failures are the shared typed Google error (`GbpProviderError` from
 * lib/gbp/provider/types): the token endpoint and the HTTP classifier are the
 * same code for both Google products, so the error type is too. Its message is
 * fixed per kind and never carries a token or a response body.
 *
 * Only the member's PRIMARY calendar is ever addressed (ruling 7): picking
 * another calendar needs the `calendarlist` scope, which is not requested.
 */

/** A start or end as Google returns it: a timed event, or an all-day `date`. */
export interface GcalEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

/** The fields of a Google event that decide whether it is busy time. */
export interface GcalEvent {
  id: string;
  /** "confirmed" | "tentative" | "cancelled". */
  status?: string;
  /** "opaque" (busy, the default) | "transparent" (shows as free). */
  transparency?: string;
  start?: GcalEventTime;
  end?: GcalEventTime;
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  extendedProperties?: { private?: Record<string, string> };
  summary?: string;
  /** Read by the calendar import only, and stored only in "details" mode. */
  location?: string;
  /** "private" / "confidential" events import as "Busy" in every mode. */
  visibility?: string;
  /** Google's own kind, e.g. "workingLocation" or "birthday" (not appointments). */
  eventType?: string;
}

export interface GcalEventList {
  items: GcalEvent[];
  /** The calendar's own timezone — what an all-day `date` is relative to. */
  timeZone: string | null;
}

/** One events.list walk for the calendar import (full or incremental). */
export interface GcalSyncResult {
  items: GcalEvent[];
  timeZone: string | null;
  /** Google's token for the next incremental walk; null when the walk stopped early. */
  nextSyncToken: string | null;
  /** True when pages were left unread (`maxPages`): absence proves nothing. */
  truncated: boolean;
}

/** Google answered 410 Gone to a sync token: the caller must run a full sync. */
export class GcalSyncTokenExpiredError extends Error {
  constructor() {
    super("Google Calendar sync token expired");
    this.name = "GcalSyncTokenExpiredError";
  }
}

/** What LeadStack writes for a booking. */
export interface GcalEventInput {
  /** Always "confirmed": re-writing an event the member deleted restores it (ruling 9). */
  status: "confirmed";
  summary: string;
  description: string;
  location: string;
  start: { dateTime: string };
  end: { dateTime: string };
  /** `leadstackEventId` marks the event as ours: busy loading skips it. */
  extendedProperties: { private: { leadstackEventId: string } };
}

export interface GcalProvider {
  // OAuth -------------------------------------------------------------------
  /** The consent URL (the fake skips the Google hop and targets the callback). */
  authorizeUrl(opts: { redirectUri: string; state: string }): string;
  exchangeCode(code: string, redirectUri: string): Promise<GoogleTokens>;
  /** `refreshToken` on the result is non-null only when Google rotated it. */
  refresh(refreshToken: string, signal?: AbortSignal): Promise<GoogleTokens>;
  /** The Google account's email, for "Connected as …". Null when absent. */
  userEmail(accessToken: string): Promise<string | null>;

  // Primary calendar --------------------------------------------------------
  /** Single (expanded) events overlapping [timeMin, timeMax), every page. */
  listEvents(
    accessToken: string,
    window: { timeMin: Date; timeMax: Date },
    signal?: AbortSignal,
  ): Promise<GcalEventList>;
  /**
   * The calendar import's walk. `syncToken` null = a full walk of
   * [timeMin, timeMax); otherwise only what changed since that token
   * (cancelled events included), and the window is NOT applied by Google.
   * Throws GcalSyncTokenExpiredError when Google refuses the token (410).
   * `details` false: titles and places are not even requested. `ordered`
   * (full walks only): by start time, soonest first — Google then returns no
   * sync token.
   */
  syncEvents(
    accessToken: string,
    opts: { syncToken: string | null; timeMin: Date; timeMax: Date; maxPages: number; details: boolean; ordered?: boolean },
    signal?: AbortSignal,
  ): Promise<GcalSyncResult>;
  /**
   * Create the event under OUR id, or — when that id already exists (409) —
   * overwrite it. Idempotent, so two racing pushes can never duplicate.
   */
  putEvent(accessToken: string, eventId: string, input: GcalEventInput, signal?: AbortSignal): Promise<void>;
  /** Throws `not_found` for an event that is already gone. */
  deleteEvent(accessToken: string, eventId: string, signal?: AbortSignal): Promise<void>;
}

/** Google event ids are base32hex; anchored so an id can't smuggle a path. */
export const GCAL_EVENT_ID_RE = /^[A-Za-z0-9_-]{1,1024}$/;

