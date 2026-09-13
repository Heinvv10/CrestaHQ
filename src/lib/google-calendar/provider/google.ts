import "server-only";

import { buildGoogleOAuthUrl } from "@/lib/google/oauth";
import { bearer, fetchJson } from "@/lib/gbp/provider/google-http";
import { exchangeCode, refresh, revoke } from "@/lib/gbp/provider/google-token";
import { GbpProviderError } from "@/lib/gbp/provider/types";
import { GCAL_SCOPES } from "../scopes";
import {
  GCAL_EVENT_ID_RE,
  type GcalEvent,
  type GcalEventInput,
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

function init(accessToken: string, method = "GET", body?: unknown): RequestInit {
  return {
    method,
    headers: {
      ...bearer(accessToken),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
  refresh,
  revoke,

  async userEmail(accessToken) {
    const body = (await fetchJson(USERINFO, init(accessToken))) as { email?: unknown } | null;
    return typeof body?.email === "string" && body.email ? body.email : null;
  },

  async listEvents(accessToken, { timeMin, timeMax }) {
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
      const body = (await fetchJson(`${EVENTS}?${params}`, init(accessToken))) as {
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

  async insertEvent(accessToken, input: GcalEventInput) {
    const body = (await fetchJson(EVENTS, init(accessToken, "POST", input))) as { id?: unknown } | null;
    if (typeof body?.id !== "string" || !GCAL_EVENT_ID_RE.test(body.id)) {
      throw new GbpProviderError("malformed");
    }
    return body.id;
  },

  async patchEvent(accessToken, eventId, input) {
    await fetchJson(eventUrl(eventId), init(accessToken, "PATCH", input));
  },

  async deleteEvent(accessToken, eventId) {
    try {
      await fetchJson(eventUrl(eventId), init(accessToken, "DELETE"));
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
