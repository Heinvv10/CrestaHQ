import "server-only";

import { buildGoogleOAuthUrl } from "@/lib/google/oauth";
import { bearer, fetchJson } from "@/lib/gbp/provider/google-http";
import { exchangeCode, refresh } from "@/lib/gbp/provider/google-token";
import { GbpProviderError } from "@/lib/gbp/provider/types";
import { GCAL_SCOPES } from "../scopes";
import {
  GCAL_EVENT_ID_RE,
  GcalSyncTokenExpiredError,
  type GcalEvent,
  type GcalProvider,
} from "./types";

/**
 * The real Google Calendar provider. The token endpoint (exchange, refresh,
 * revoke) and the HTTP→typed-error mapping are the GBP provider's own
 * functions — same OAuth client, same Google error shapes.
 */

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
/** A socket that never answers must not hold a booking request open. */
const REQUEST_TIMEOUT_MS = 5_000;
/** 250 events per page × 10 pages is far beyond any real two-week window. */
const MAX_PAGES = 10;
/**
 * The import's field masks: never descriptions, attendee emails, conference
 * links or attachments, and no title or place unless the member shares
 * details — what is not fetched cannot be stored.
 */
const SYNC_ITEM = "id,status,visibility,transparency,eventType,start,end,attendees(self,responseStatus),extendedProperties/private";
const syncFields = (details: boolean) =>
  `nextPageToken,nextSyncToken,timeZone,items(${SYNC_ITEM}${details ? ",summary,location" : ""})`;

function init(accessToken: string, method = "GET", body?: unknown, signal?: AbortSignal): RequestInit {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return {
    method,
    headers: {
      ...bearer(accessToken),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  };
}

function eventUrl(eventId: string): string {
  if (!GCAL_EVENT_ID_RE.test(eventId)) throw new GbpProviderError("malformed");
  return `${EVENTS}/${eventId}`;
}

export const googleGcalProvider: GcalProvider = {
  authorizeUrl({ redirectUri, state }) {
    return buildGoogleOAuthUrl({ redirectUri, state, scope: GCAL_SCOPES.join(" ") });
  },
  exchangeCode,
  refresh: (refreshToken, signal) => refresh(refreshToken, signal),

  async userEmail(accessToken) {
    const body = (await fetchJson(USERINFO, init(accessToken))) as { email?: unknown } | null;
    return typeof body?.email === "string" && body.email ? body.email : null;
  },

  async listEvents(accessToken, { timeMin, timeMax }, signal) {
    const items: GcalEvent[] = [];
    let timeZone: string | null = null;
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const body = (await fetchJson(`${EVENTS}?${params}`, init(accessToken, "GET", undefined, signal))) as {
        items?: unknown;
        timeZone?: unknown;
        nextPageToken?: unknown;
      } | null;
      if (!body || !Array.isArray(body.items)) throw new GbpProviderError("malformed");
      items.push(...(body.items as GcalEvent[]));
      if (typeof body.timeZone === "string") timeZone = body.timeZone;
      pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : null;
      if (!pageToken) return { items, timeZone };
    }
    // A window that still has pages left is not fully read: busy time would
    // be missing. Refuse, so the caller records it and fails open visibly.
    throw new GbpProviderError("malformed");
  },

  async syncEvents(accessToken, { syncToken, timeMin, timeMax, maxPages, details }, signal) {
    const items: GcalEvent[] = [];
    let timeZone: string | null = null;
    let pageToken: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      // A sync token may not be combined with timeMin/timeMax (Google 400s).
      const params = new URLSearchParams({ singleEvents: "true", maxResults: "250", fields: syncFields(details) });
      if (syncToken) params.set("syncToken", syncToken);
      else {
        params.set("timeMin", timeMin.toISOString());
        params.set("timeMax", timeMax.toISOString());
      }
      if (pageToken) params.set("pageToken", pageToken);
      let body: { items?: unknown; timeZone?: unknown; nextPageToken?: unknown; nextSyncToken?: unknown } | null;
      try {
        body = (await fetchJson(`${EVENTS}?${params}`, init(accessToken, "GET", undefined, signal))) as typeof body;
      } catch (err) {
        if (syncToken && err instanceof GbpProviderError && err.status === 410) throw new GcalSyncTokenExpiredError();
        throw err;
      }
      if (!body || !Array.isArray(body.items)) throw new GbpProviderError("malformed");
      items.push(...(body.items as GcalEvent[]));
      if (typeof body.timeZone === "string") timeZone = body.timeZone;
      pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : null;
      if (!pageToken) {
        const next = typeof body.nextSyncToken === "string" && body.nextSyncToken ? body.nextSyncToken : null;
        return { items, timeZone, nextSyncToken: next, truncated: false };
      }
    }
    return { items, timeZone, nextSyncToken: null, truncated: true };
  },

  async putEvent(accessToken, eventId, input, signal) {
    const url = eventUrl(eventId);
    try {
      await fetchJson(EVENTS, init(accessToken, "POST", { id: eventId, ...input }, signal));
    } catch (err) {
      // Our id already exists (an earlier push, or a racing one): overwrite.
      if (!(err instanceof GbpProviderError && err.status === 409)) throw err;
      await fetchJson(url, init(accessToken, "PATCH", input, signal));
    }
  },

  async deleteEvent(accessToken, eventId, signal) {
    try {
      await fetchJson(eventUrl(eventId), init(accessToken, "DELETE", undefined, signal));
    } catch (err) {
      // Google answers 410 Gone for an event already deleted; that is the
      // same outcome as 404 for every caller.
      if (err instanceof GbpProviderError && err.status === 410) {
        throw new GbpProviderError("not_found", { status: 410 });
      }
      throw err;
    }
  },
};
