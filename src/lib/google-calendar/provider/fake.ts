import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { GoogleTokens } from "@/lib/google/oauth";
import { GbpProviderError, type GbpProviderErrorKind } from "@/lib/gbp/provider/types";
import { GCAL_SCOPE } from "../scopes";
import type { GcalEvent, GcalEventInput, GcalProvider } from "./types";

/**
 * Deterministic stand-in for one member's Google Calendar. Reachable only
 * through `getGcalProviderFor` in select.ts, which refuses it outside
 * loopback dev/CI and outside the fixture agency.
 *
 * Each instance is BOUND to one (sub-account, member): codes and tokens encode
 * both (`fake-gcal-code:{sa}:{uid}`, `fake-gcal-access:{sa}:{uid}:{n}`, …) and
 * one naming anyone else is refused the way Google refuses a foreign
 * credential, so a valid fixture state plus a code naming a real tenant can't
 * point anything at that tenant.
 *
 * The calendar lives in Firestore (`private/googleCalendarFake_{uid}`) so a
 * Playwright spec can seed busy time, read back what was pushed, and revoke
 * the grant (`revoked: true` — refresh then answers invalid_grant and access
 * tokens stop working, as at Google).
 */

export type FakeGcalOp = "exchangeCode" | "refresh" | "listEvents" | "insertEvent" | "patchEvent" | "deleteEvent";

export interface FakeGcalEvent extends GcalEvent {
  description?: string;
  location?: string;
}

export interface FakeCalendar {
  email?: string;
  revoked?: boolean;
  events: FakeGcalEvent[];
  /** Fail the next call of `op` once with `kind`, then clear. */
  failNext?: { op: FakeGcalOp; kind: GbpProviderErrorKind };
}

export interface FakeCalendarStore {
  get(subAccountId: string, uid: string): Promise<FakeCalendar | null>;
  set(subAccountId: string, uid: string, calendar: FakeCalendar): Promise<void>;
}

/** Locked path: default-deny rules already cover `private/*`. */
export function fakeCalendarPath(subAccountId: string, uid: string): string {
  return `subAccounts/${subAccountId}/private/googleCalendarFake_${uid}`;
}

export class FirestoreFakeCalendarStore implements FakeCalendarStore {
  async get(subAccountId: string, uid: string): Promise<FakeCalendar | null> {
    const snap = await getAdminDb().doc(fakeCalendarPath(subAccountId, uid)).get();
    return snap.exists ? (snap.data() as FakeCalendar) : null;
  }

  async set(subAccountId: string, uid: string, calendar: FakeCalendar): Promise<void> {
    await getAdminDb().doc(fakeCalendarPath(subAccountId, uid)).set(calendar);
  }
}

export const FAKE_GCAL_EMAIL = "fixture-host@example.invalid";

/** Counter shared by every instance so tokens and ids stay unique per process. */
let counter = 0;
const next = () => `${Date.now().toString(36)}${++counter}`;

export function createFakeGcalProvider(
  store: FakeCalendarStore,
  bound: { subAccountId: string; uid: string },
): GcalProvider {
  const who = `${bound.subAccountId}:${bound.uid}`;
  const mine = (prefix: string, value: string) =>
    value.startsWith(`${prefix}:${who}:`) || value === `${prefix}:${who}`;

  async function load(): Promise<FakeCalendar> {
    return (await store.get(bound.subAccountId, bound.uid)) ?? { events: [] };
  }
  const save = (c: FakeCalendar) => store.set(bound.subAccountId, bound.uid, c);

  /** Throw the scripted failure for `op` once, persisting that it was used. */
  async function consume(calendar: FakeCalendar, op: FakeGcalOp) {
    if (calendar.failNext?.op !== op) return;
    const { kind } = calendar.failNext;
    delete calendar.failNext;
    await save(calendar);
    throw new GbpProviderError(kind);
  }

  function mint(withRefresh: boolean): GoogleTokens {
    const n = next();
    return {
      accessToken: `fake-gcal-access:${who}:${n}`,
      refreshToken: withRefresh ? `fake-gcal-refresh:${who}:${n}` : null,
      expiresAt: Date.now() + 3600_000,
      scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email", GCAL_SCOPE],
    };
  }

  /** Resolve a bearer to the calendar, like Google checking an access token. */
  async function authed(accessToken: string, op: FakeGcalOp): Promise<FakeCalendar> {
    if (!mine("fake-gcal-access", accessToken)) {
      throw new GbpProviderError("auth_expired", { status: 401 });
    }
    const calendar = await load();
    await consume(calendar, op);
    if (calendar.revoked) throw new GbpProviderError("auth_expired", { status: 401 });
    return calendar;
  }

  const toEvent = (id: string, input: GcalEventInput): FakeGcalEvent => ({
    id,
    status: "confirmed",
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: input.start,
    end: input.end,
    extendedProperties: input.extendedProperties,
  });

  return {
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(redirectUri);
      url.searchParams.set("code", `fake-gcal-code:${who}`);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code) {
      if (!mine("fake-gcal-code", code)) throw new GbpProviderError("revoked", { status: 400 });
      const calendar = await load();
      await consume(calendar, "exchangeCode");
      // A fresh consent is a fresh grant.
      if (calendar.revoked) await save({ ...calendar, revoked: false });
      return mint(true);
    },

    async refresh(refreshToken) {
      if (!mine("fake-gcal-refresh", refreshToken)) throw new GbpProviderError("revoked", { status: 400 });
      const calendar = await load();
      await consume(calendar, "refresh");
      if (calendar.revoked) throw new GbpProviderError("revoked", { status: 400 });
      return mint(false);
    },

    async userEmail(accessToken) {
      const calendar = await authed(accessToken, "listEvents");
      return calendar.email ?? FAKE_GCAL_EMAIL;
    },

    async listEvents(accessToken, { timeMin, timeMax }) {
      const calendar = await authed(accessToken, "listEvents");
      const overlaps = (e: FakeGcalEvent) => {
        const start = Date.parse(e.start?.dateTime ?? `${e.start?.date}T00:00:00Z`);
        const end = Date.parse(e.end?.dateTime ?? `${e.end?.date}T00:00:00Z`);
        return start < timeMax.getTime() && end > timeMin.getTime();
      };
      return { items: calendar.events.filter(overlaps), timeZone: "UTC" };
    },

    async insertEvent(accessToken, input) {
      const calendar = await authed(accessToken, "insertEvent");
      const id = `fakegevt${next()}`;
      calendar.events = [...calendar.events, toEvent(id, input)];
      await save(calendar);
      return id;
    },

    async patchEvent(accessToken, eventId, input) {
      const calendar = await authed(accessToken, "patchEvent");
      const i = calendar.events.findIndex((e) => e.id === eventId);
      if (i < 0) throw new GbpProviderError("not_found", { status: 404 });
      calendar.events[i] = toEvent(eventId, input);
      await save(calendar);
    },

    async deleteEvent(accessToken, eventId) {
      const calendar = await authed(accessToken, "deleteEvent");
      if (!calendar.events.some((e) => e.id === eventId)) {
        throw new GbpProviderError("not_found", { status: 404 });
      }
      calendar.events = calendar.events.filter((e) => e.id !== eventId);
      await save(calendar);
    },
  };
}
