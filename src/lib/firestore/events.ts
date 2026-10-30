import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  type QueryConstraint,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { addActivity } from "@/lib/firestore/activities";
import { territoryIdForContact } from "@/lib/firestore/territory-inherit";
import {
  NOOP_UNSUB,
  territoryQueryPlan,
} from "@/lib/firestore/territory-query";
import { isImportedEvent, type CalendarEvent, type EventFormData } from "@/types/events";
import { GLOBAL_TERRITORY_ID, type TenantScope } from "@/types";
import { isLongEvent } from "@/lib/booking/long-event";

const EVENTS = "events";

export interface EventQueryOptions {
  /** Territory filter for scoped collaborators. `null` (default) = no
   *  filter. See deals.ts for the full contract. */
  territoryFilter?: string[] | null;
}

export function subscribeToEvents(
  scope: TenantScope,
  callback: (events: CalendarEvent[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe;
export function subscribeToEvents(
  scope: TenantScope,
  opts: EventQueryOptions,
  callback: (events: CalendarEvent[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe;
export function subscribeToEvents(
  scope: TenantScope,
  callbackOrOpts: ((events: CalendarEvent[]) => void) | EventQueryOptions,
  callbackOrError?:
    | ((events: CalendarEvent[]) => void)
    | ((err: Error) => void),
  onErrorMaybe?: (err: Error) => void,
): Unsubscribe {
  const opts: EventQueryOptions =
    typeof callbackOrOpts === "function" ? {} : callbackOrOpts;
  const callback: (events: CalendarEvent[]) => void =
    typeof callbackOrOpts === "function"
      ? callbackOrOpts
      : (callbackOrError as (events: CalendarEvent[]) => void);
  const onError: ((err: Error) => void) | undefined =
    typeof callbackOrOpts === "function"
      ? (callbackOrError as ((err: Error) => void) | undefined)
      : onErrorMaybe;

  const plan = territoryQueryPlan(opts.territoryFilter);
  if (plan.mode === "empty") {
    callback([]);
    return NOOP_UNSUB;
  }
  const constraints: QueryConstraint[] = [
    where("subAccountId", "==", scope.subAccountId),
  ];
  if (plan.mode === "in") constraints.push(plan.constraint);
  const q = query(collection(getFirebaseDb(), EVENTS), ...constraints);
  return onSnapshot(
    q,
    (snap) => {
      const events = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<CalendarEvent, "id">) }),
      );
      events.sort((a, b) => toMillis(a.startAt) - toMillis(b.startAt));
      callback(events);
    },
    (err) => onError?.(err),
  );
}

/** Upcoming half of the appointments list: soonest first, capped. */
export const APPOINTMENTS_UPCOMING_LIMIT = 500;
/** Past half: newest first, one page at a time ("Load older" adds one). */
export const APPOINTMENTS_PAST_PAGE = 200;

export interface AppointmentsSnapshot {
  events: CalendarEvent[];
  /** The half hit its limit, so more events exist than were loaded. */
  upcomingTruncated: boolean;
  pastTruncated: boolean;
  /** Halves whose query errored; their events are missing from `events`. */
  failedHalves: ("upcoming" | "past")[];
}

/**
 * The appointments list's listener. `subscribeToEvents` reads a
 * sub-account's whole history (1,894 docs on the E2E tenant), which is
 * what made row updates arrive late. This splits the list at the moment of
 * subscribing: every event from then on (capped at
 * APPOINTMENTS_UPCOMING_LIMIT) plus the newest `pastLimit` before it. The
 * two halves partition on the same boundary, so an event is in exactly one;
 * the `*Truncated` flags let the page say when older events are not fetched.
 * An event with no `startAt` matches neither half.
 */
export function subscribeToAppointments(
  scope: TenantScope,
  opts: EventQueryOptions & { pastLimit: number },
  callback: (snapshot: AppointmentsSnapshot) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const plan = territoryQueryPlan(opts.territoryFilter);
  if (plan.mode === "empty") {
    callback({ events: [], upcomingTruncated: false, pastTruncated: false, failedHalves: [] });
    return NOOP_UNSUB;
  }
  const base: QueryConstraint[] = [
    where("subAccountId", "==", scope.subAccountId),
  ];
  if (plan.mode === "in") base.push(plan.constraint);
  const boundary = Timestamp.fromMillis(Date.now());
  // A half is its real events (imported Google events dropped) and whether
  // more real ones exist than `want`, "failed", or null (not answered yet).
  type Half = { docs: QueryDocumentSnapshot[]; truncated: boolean } | "failed" | null;
  let upcoming: Half = null;
  let past: Half = null;
  let errored = false;
  // Held until both halves have answered, so the list never renders one
  // half as if it were everything. A failed half counts as answered: the
  // other half still renders and `failedHalves` says what is missing.
  const emit = () => {
    if (!upcoming || !past) return;
    const byId = new Map<string, CalendarEvent>();
    for (const d of [
      ...(past === "failed" ? [] : past.docs),
      ...(upcoming === "failed" ? [] : upcoming.docs),
    ]) {
      byId.set(d.id, { id: d.id, ...(d.data() as Omit<CalendarEvent, "id">) });
    }
    const events = [...byId.values()];
    events.sort((a, b) => toMillis(a.startAt) - toMillis(b.startAt));
    callback({
      events,
      upcomingTruncated: upcoming !== "failed" && upcoming.truncated,
      pastTruncated: past !== "failed" && past.truncated,
      failedHalves: [
        ...(upcoming === "failed" ? (["upcoming"] as const) : []),
        ...(past === "failed" ? (["past"] as const) : []),
      ],
    });
  };
  // Both halves usually fail together (a missing index); report once.
  const fail = (err: Error) => {
    if (!errored) onError?.(err);
    errored = true;
  };
  const upcomingHalf = listenHalf(
    [...base, where("startAt", ">=", boundary), orderBy("startAt", "asc")],
    APPOINTMENTS_UPCOMING_LIMIT,
    (h) => {
      upcoming = h;
      emit();
    },
    fail,
  );
  const pastHalf = listenHalf(
    [...base, where("startAt", "<", boundary), orderBy("startAt", "desc")],
    opts.pastLimit,
    (h) => {
      past = h;
      emit();
    },
    fail,
  );
  return () => {
    upcomingHalf();
    pastHalf();
  };
}

/** How far a half may grow past its imported Google events: this many times its limit. */
const APPOINTMENTS_REFILL_FACTOR = 4;

/**
 * One appointments half: the first `want` REAL events of the ordered query.
 * Imported Google events are dropped (they stay on the calendar only), and
 * the listener re-subscribes with a larger limit until they no longer take
 * real events' places — one more than `want` real, or the query is
 * exhausted. Past APPOINTMENTS_REFILL_FACTOR × the limit it stops growing
 * and reports truncated, since more real events may exist.
 */
function listenHalf(
  constraints: QueryConstraint[],
  want: number,
  onHalf: (half: { docs: QueryDocumentSnapshot[]; truncated: boolean } | "failed") => void,
  onFail: (err: Error) => void,
): Unsubscribe {
  const col = collection(getFirebaseDb(), EVENTS);
  const maxFetch = (want + 1) * APPOINTMENTS_REFILL_FACTOR;
  // One more than the limit: a full half only counts as truncated when the
  // extra real document really exists. The extra is never shown.
  let fetchLimit = want + 1;
  let unsub: Unsubscribe = NOOP_UNSUB;
  const listen = () => {
    unsub = onSnapshot(
      query(col, ...constraints, limit(fetchLimit)),
      (snap) => {
        const real = snap.docs.filter((d) => !isImportedEvent(d.data()));
        const full = snap.docs.length >= fetchLimit;
        if (full && real.length <= want && fetchLimit < maxFetch) {
          // Imported events took real ones' places: refill past them.
          fetchLimit = Math.min(maxFetch, want + 1 + (snap.docs.length - real.length));
          unsub();
          listen();
          return;
        }
        onHalf({ docs: real.slice(0, want), truncated: real.length > want || full });
      },
      (err) => {
        onFail(err);
        onHalf("failed");
      },
    );
  };
  listen();
  return () => unsub();
}

export async function createEvent(
  scope: TenantScope,
  createdByUid: string,
  data: EventFormData,
): Promise<string> {
  const territoryId =
    (await territoryIdForContact(data.contactId)) ?? GLOBAL_TERRITORY_ID;
  const ref = await addDoc(collection(getFirebaseDb(), EVENTS), {
    title: data.title,
    startAt: Timestamp.fromDate(data.startAt),
    endAt: Timestamp.fromDate(data.endAt),
    isLong: isLongEvent(data.startAt, data.endAt),
    contactId: data.contactId,
    location: data.location,
    notes: data.notes,
    meetingUrl: data.meetingUrl ?? null,
    agencyId: scope.agencyId,
    subAccountId: scope.subAccountId,
    createdByUid,
    territoryId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  if (data.contactId) {
    await addActivity(data.contactId, {
      type: "booking_created",
      createdBy: createdByUid,
      content: `Event "${data.title}" scheduled for ${formatShort(data.startAt)}`,
      meta: { bookingId: ref.id },
    });
  }
  return ref.id;
}

export async function updateEvent(
  id: string,
  data: Partial<EventFormData>,
): Promise<void> {
  const patch: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (data.title !== undefined) patch.title = data.title;
  if (data.startAt !== undefined)
    patch.startAt = Timestamp.fromDate(data.startAt);
  if (data.endAt !== undefined) patch.endAt = Timestamp.fromDate(data.endAt);
  // The dialog always sends both times together.
  if (data.startAt !== undefined && data.endAt !== undefined) {
    patch.isLong = isLongEvent(data.startAt, data.endAt);
  }
  if (data.contactId !== undefined) {
    patch.contactId = data.contactId;
    // Re-derive territory when the linked contact changes so the event
    // follows the new account's territory (Global when unlinked).
    patch.territoryId =
      (await territoryIdForContact(data.contactId)) ?? GLOBAL_TERRITORY_ID;
  }
  if (data.location !== undefined) patch.location = data.location;
  if (data.notes !== undefined) patch.notes = data.notes;
  if (data.meetingUrl !== undefined) patch.meetingUrl = data.meetingUrl;
  await updateDoc(doc(getFirebaseDb(), EVENTS, id), patch);
}

export async function deleteEvent(id: string): Promise<void> {
  await deleteDoc(doc(getFirebaseDb(), EVENTS, id));
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}

function formatShort(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
