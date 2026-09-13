import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { pageCalendarType } from "@/lib/booking/calendar-types";
import {
  hostSelectionEnabled,
  pageService,
  selectableHostUid,
  type PageSlot,
} from "@/lib/booking/page-slots";
import {
  BusyQueryError,
  departedHostMessage,
  movingEventOf,
  resolvePageAvailability,
  type ResolveAvailabilityOptions,
} from "@/lib/booking/resolve-availability";
import { loadGoogleBusyForPage } from "@/lib/google-calendar/busy";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";

/**
 * Public availability endpoint for a booking page. Unauthenticated;
 * security is per-page (only published pages return slots) plus a soft
 * per-IP rate limit.
 *
 *   GET /api/booking/[saId]/[slug]/availability?from=ISO&to=ISO
 *
 * - 404 if the page doesn't exist or isn't published.
 * - 200 with { slots: [{ startAt, endAt }] } on success.
 *
 * Server-side reads via Admin SDK so Firestore rules can stay
 * member-scoped on the booking-page doc + events. Slots come from
 * `resolvePageAvailability` — the same resolver booking re-verifies with.
 *
 * Service pages need `?serviceId=`; class pages add `seatsLeft` per slot.
 */

// ── Soft rate limit: per-IP, in-memory LRU. Mirrors web-chat rate-limit ──
const HOURLY_CAP = 120; // ~2/min ought to be plenty for legit visitors
const WINDOW_MS = 60 * 60_000;
const ipHits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const arr = (ipHits.get(ip) ?? []).filter((t) => t >= cutoff);
  if (arr.length >= HOURLY_CAP) {
    ipHits.set(ip, arr);
    return true;
  }
  arr.push(now);
  ipHits.set(ip, arr);
  // Cheap LRU pressure: keep map size bounded.
  if (ipHits.size > 5000) {
    const oldest = ipHits.keys().next().value;
    if (oldest !== undefined) ipHits.delete(oldest);
  }
  return false;
}

function getClientIp(request: Request): string {
  // x-forwarded-for is the standard proxy header. Fall back to a
  // sentinel so unconfigured envs still rate-limit (per-instance).
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ saId: string; slug: string }> },
) {
  const { saId, slug } = await ctx.params;

  if (isRateLimited(getClientIp(request))) {
    return NextResponse.json(
      { error: "Too many requests. Try again in a minute." },
      { status: 429 },
    );
  }

  const db = getAdminDb();
  const pageSnap = await db
    .doc(`subAccounts/${saId}/bookingPages/${slug}`)
    .get();
  // Treat "missing" and "draft" as the same response so we don't leak
  // the existence of unpublished pages.
  if (!pageSnap.exists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const page = pageSnap.data() as BookingPage;
  if (page.status !== "published") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Optional query params. Default to "now" / `now + visibleDays` which
  // computeAvailability also enforces, so passing nothing is fine.
  // `excludeEventId` is used by the reschedule flow so the attendee sees
  // their own current slot as available.
  const url = new URL(request.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const excludeEventId = url.searchParams.get("excludeEventId");
  const now = new Date();
  const fromInstant = fromParam ? new Date(fromParam) : undefined;
  const toInstant = toParam ? new Date(toParam) : undefined;
  if (fromInstant && Number.isNaN(fromInstant.getTime())) {
    return NextResponse.json(
      { error: "Invalid `from` query param." },
      { status: 400 },
    );
  }
  if (toInstant && Number.isNaN(toInstant.getTime())) {
    return NextResponse.json(
      { error: "Invalid `to` query param." },
      { status: 400 },
    );
  }

  // Reschedule view: the attendee's own event is not busy, and the slots are
  // the ones the reschedule route will accept — that event's own host(s),
  // service and length. Only an event booked on THIS page is excluded or
  // narrows anything: naming someone else's booking must not free its time.
  let movingEvent: ResolveAvailabilityOptions["movingEvent"] = null;
  let eventServiceId: string | null = null;
  if (excludeEventId && !excludeEventId.includes("/")) {
    const evSnap = await db.collection("events").doc(excludeEventId).get();
    const ev = evSnap.exists ? (evSnap.data() as CalendarEvent) : null;
    if (ev && ev.subAccountId === saId && ev.bookingPageSlug === slug) {
      const departed = await departedHostMessage(page, ev);
      if (departed) return NextResponse.json({ error: departed }, { status: 409 });
      movingEvent = movingEventOf(evSnap.id, ev);
      eventServiceId = ev.serviceId ?? null;
    }
  }

  const type = pageCalendarType(page);
  const serviceId = movingEvent ? eventServiceId : url.searchParams.get("serviceId");
  if (type === "service" && !movingEvent && !pageService(page, serviceId)) {
    return NextResponse.json(
      { error: "Pick a service first." },
      { status: 400 },
    );
  }

  const hosts = page.hosts ?? [];
  // Host names + narrowing are ONLY available when the operator opted the
  // page into named selection. An opted-out page never leaks staff names and
  // never narrows, even if a `host` param is forged onto the request.
  const allowHostSelection = hostSelectionEnabled(page);
  const selectedHostUid = selectableHostUid(page, url.searchParams.get("host"));

  // Hosts' Google busy time (SP3 G2) — fail open, never in a transaction.
  const externalBusy = await loadGoogleBusyForPage({
    subAccountId: saId,
    page,
    now,
    fromInstant,
    toInstant,
  });

  let slots: PageSlot[];
  try {
    slots = await resolvePageAvailability({
      subAccountId: saId,
      page,
      now,
      fromInstant,
      toInstant,
      onlyHostUid: selectedHostUid,
      movingEvent,
      serviceId,
      externalBusy,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (err instanceof BusyQueryError) {
      // Most common cause: missing Firestore composite index in production.
      // Firebase returns FAILED_PRECONDITION with a link in the error message
      // to auto-create the index. Surfacing this with the saId + slug context
      // makes the Vercel log line greppable.
      console.error(
        `[booking/availability] events query failed sa=${saId} slug=${slug}: ${message}`,
        err.original,
      );
      return NextResponse.json(
        {
          error: "availability_query_failed",
          message:
            "Couldn't load availability. The deployment may be missing a Firestore index; ask the agency operator to deploy indexes (`firebase deploy --only firestore:indexes`).",
        },
        { status: 500 },
      );
    }
    // Defensive: slot computation can throw on malformed page config
    // (missing workingHours, invalid timezone, etc.). Log with context so
    // the operator can identify the broken booking page.
    console.error(
      `[booking/availability] compute failed sa=${saId} slug=${slug}: ${message}`,
      err,
    );
    return NextResponse.json(
      {
        error: "availability_compute_failed",
        message:
          "Couldn't compute availability — the booking page config may be malformed (working hours / timezone / duration).",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    slots: slots.map((s) => ({
      startAt: s.startAt.toISOString(),
      endAt: s.endAt.toISOString(),
      // Class pages only — the public page shows "N seats left".
      ...(s.seatsLeft !== undefined ? { seatsLeft: s.seatsLeft } : {}),
    })),
    timezone: page.timezone,
    durationMinutes:
      pageService(page, serviceId)?.durationMinutes ??
      (type === "service" && movingEvent
        ? movingEvent.durationMinutes
        : page.durationMinutes),
    // Only expose the roster + applied selection on opted-in pages. Absent on
    // every other page so a pooled page can't be probed for staff names.
    ...(allowHostSelection
      ? {
          allowHostSelection: true,
          hosts: hosts.map((h) => ({ uid: h.uid, name: h.name })),
          selectedHostUid,
        }
      : {}),
  });
}
