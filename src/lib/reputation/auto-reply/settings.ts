import type { AutoReplyMode, AutoReplyStar, ReviewsAutoReplySettings } from "@/types";
import { locId, locationNamesOf, type ListingFields } from "@/lib/gbp/listings";
import { LOCATION_NAME_RE } from "@/lib/gbp/provider/types";
import { toMillis } from "@/lib/gbp/sync/types";

/**
 * Review auto-reply settings (AUTO_REPLY_V1_PLAN.md, PR 1): the shape stored
 * at `subAccounts/{id}.reviewsAutoReply`, its defaults, the strict PUT body
 * parser and the off→on stamping. Pure — the route owns auth, gates and the
 * transaction. Nothing here drafts or posts.
 */

const AUTO_REPLY_STARS: readonly AutoReplyStar[] = [1, 2, 3, 4, 5];

/** Shown read-only on the settings card; enforced by the engine (PR 2). */
export const AUTO_REPLY_DAILY_POST_CAP = 20;
export const AUTO_REPLY_DAILY_DRAFT_CAP = 40;

/**
 * Whether the route may switch auto-reply on. PR 1 shipped it false (409
 * `not_available`); the engine (run.ts) exists since PR 2. Whether the engine
 * RUNS on a deployment is the separate `REVIEWS_AUTO_REPLY_ENABLED` kill
 * switch (kill-switch.ts).
 */
export const AUTO_REPLY_ENGINE_AVAILABLE = true;

const DEFAULT_AUTO_REPLY_MODES: Readonly<Record<AutoReplyStar, AutoReplyMode>> = {
  1: "approval",
  2: "approval",
  3: "approval",
  4: "auto",
  5: "auto",
};

/**
 * What an admin may send: exactly these three keys, plus optionally
 * `listings` — `{locationName: on}` for EXTRA listings only (the main
 * listing's switch is `enabled`). A listing left out keeps its state.
 */
interface AutoReplyInput {
  enabled: boolean;
  modes: Record<AutoReplyStar, AutoReplyMode>;
  includeBacklog: boolean;
  listings?: Record<string, boolean>;
}

const BODY_KEYS = ["enabled", "includeBacklog", "modes"];
const BODY_KEYS_WITH_LISTINGS = ["enabled", "includeBacklog", "listings", "modes"];
const STAR_KEYS = AUTO_REPLY_STARS.map(String);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isMode = (v: unknown): v is AutoReplyMode => v === "auto" || v === "approval";
const sameKeys = (obj: Record<string, unknown>, keys: string[]) => {
  const got = Object.keys(obj).sort();
  return got.length === keys.length && got.every((k, i) => k === keys[i]);
};

/** The PUT body, or null when it is anything but the exact allow-listed shape. */
export function parseAutoReplyBody(body: unknown): AutoReplyInput | null {
  if (!isPlainObject(body) || !(sameKeys(body, BODY_KEYS) || sameKeys(body, BODY_KEYS_WITH_LISTINGS))) return null;
  const { enabled, includeBacklog, modes, listings } = body;
  if (typeof enabled !== "boolean" || typeof includeBacklog !== "boolean") return null;
  if (!isPlainObject(modes) || !sameKeys(modes, STAR_KEYS)) return null;
  if (!STAR_KEYS.every((k) => isMode(modes[k]))) return null;
  const parsed = {} as Record<AutoReplyStar, AutoReplyMode>;
  for (const star of AUTO_REPLY_STARS) parsed[star] = modes[String(star)] as AutoReplyMode;
  if (listings === undefined) return { enabled, includeBacklog, modes: parsed };
  if (!isPlainObject(listings)) return null;
  const entries = Object.entries(listings);
  if (!entries.every(([loc, on]) => LOCATION_NAME_RE.test(loc) && typeof on === "boolean")) return null;
  return { enabled, includeBacklog, modes: parsed, listings: Object.fromEntries(entries) as Record<string, boolean> };
}

/** One listing auto-reply is ON for: when it was switched on, and by whom (the posts' `createdByUid`). */
export interface ListingOn {
  enabledAtMs: number | null;
  enabledByUid: string | null;
}
/** Keyed by `locationName`; a listing that is absent is off. */
export type AutoReplyListings = Record<string, ListingOn>;

/** The entry for `locationName`, or null — own keys only. */
export const listingOn = (map: AutoReplyListings, locationName: string): ListingOn | null =>
  Object.hasOwn(map, locationName) ? map[locationName] : null;

/**
 * The listings auto-reply is ON for right now (MULTI_LISTING_V1_PLAN.md H4).
 * The MAIN listing only while `enabled` and it is still the listing it was
 * enabled for; an EXTRA only while `extraListings.{locId}` exists (with its
 * stamps) AND it is still one of this sub-account's connected extras — a key
 * left behind for a listing no longer connected never counts.
 */
export function readAutoReplyListings(raw: unknown, sub: ListingFields): AutoReplyListings {
  const r = isPlainObject(raw) ? raw : {};
  const out: AutoReplyListings = {};
  const main = sub.googleListing?.locationName;
  if (r.enabled === true && typeof main === "string" && main && r.listingLocationName === main) {
    out[main] = { enabledAtMs: toMillis(r.enabledAt), enabledByUid: typeof r.enabledByUid === "string" ? r.enabledByUid : null };
  }
  const extras = isPlainObject(r.extraListings) ? r.extraListings : {};
  for (const loc of locationNamesOf(sub)) {
    if (loc === main || !Object.hasOwn(extras, locId(loc))) continue;
    const e = extras[locId(loc)];
    if (!isPlainObject(e) || typeof e.enabledByUid !== "string") continue;
    out[loc] = { enabledAtMs: toMillis(e.enabledAt), enabledByUid: e.enabledByUid };
  }
  return out;
}

/** The stored settings as the card sees them; absent or malformed fields read as the defaults. */
export function readAutoReplySettings(raw: unknown): AutoReplyInput {
  const r = isPlainObject(raw) ? raw : {};
  const stored = isPlainObject(r.modes) ? r.modes : {};
  const modes = {} as Record<AutoReplyStar, AutoReplyMode>;
  for (const star of AUTO_REPLY_STARS) {
    const m = stored[String(star)];
    modes[star] = isMode(m) ? m : DEFAULT_AUTO_REPLY_MODES[star];
  }
  return { enabled: r.enabled === true, modes, includeBacklog: r.includeBacklog === true };
}

/** `listing_changed` when a listing change or clear switched auto-reply off; otherwise null. */
export function readDisabledReason(raw: unknown): "listing_changed" | null {
  return isPlainObject(raw) && raw.disabledReason === "listing_changed" ? "listing_changed" : null;
}

type NextSettings =
  | { ok: true; value: ReviewsAutoReplySettings }
  | { ok: false; code: "no_listing" };

/**
 * The doc to write. On the off→on transition the server stamps `enabledAt`,
 * `enabledByUid` and the listing it was enabled for (refused without one);
 * on→on keeps the original stamps; on→off changes nothing but `enabled`.
 */
export function nextAutoReplySettings(
  prev: unknown,
  input: AutoReplyInput,
  ctx: { now: Date; uid: string; listingLocationName: string | null },
): NextSettings {
  const p = isPlainObject(prev) ? prev : {};
  const turningOn = input.enabled && p.enabled !== true;
  if (turningOn && !ctx.listingLocationName) return { ok: false, code: "no_listing" };
  const kept = <T>(v: unknown, guard: (x: unknown) => x is T): T | null => (guard(v) ? v : null);
  const isString = (x: unknown): x is string => typeof x === "string";
  // A Date, or a Firestore Timestamp as the admin SDK reads it back.
  const isStamp = (x: unknown): x is Date =>
    x instanceof Date || (isPlainObject(x) && typeof x.toMillis === "function");
  return {
    ok: true,
    value: {
      enabled: input.enabled,
      modes: input.modes,
      includeBacklog: input.includeBacklog,
      enabledAt: turningOn ? ctx.now : kept(p.enabledAt, isStamp),
      enabledByUid: turningOn ? ctx.uid : kept(p.enabledByUid, isString),
      listingLocationName: turningOn ? ctx.listingLocationName : kept(p.listingLocationName, isString),
      // "Switched off because the listing changed" lasts only while it stays
      // off without an admin's switch: any on, or an admin's on→off, clears it.
      disabledReason: input.enabled || p.enabled === true ? null : readDisabledReason(p),
      updatedAt: ctx.now,
      updatedByUid: ctx.uid,
    },
  };
}

/**
 * The `reviewsAutoReply.extraListings` changes a PUT's `listings` makes, by
 * `locId`: off→on stamps `enabledAt` / `enabledByUid`, on→on keeps the
 * original stamps (no write), on→off deletes the key (`null` here). The
 * caller has checked every location is a connected extra.
 */
export function extraListingWrites(
  prev: unknown,
  sub: ListingFields,
  listings: Record<string, boolean>,
  ctx: { now: Date; uid: string },
): Record<string, { enabledAt: Date; enabledByUid: string } | null> {
  const p = isPlainObject(prev) ? prev : {};
  const stored = isPlainObject(p.extraListings) ? p.extraListings : {};
  const on = readAutoReplyListings(prev, sub);
  const writes: Record<string, { enabledAt: Date; enabledByUid: string } | null> = {};
  for (const [loc, want] of Object.entries(listings)) {
    if (want && !listingOn(on, loc)) writes[locId(loc)] = { enabledAt: ctx.now, enabledByUid: ctx.uid };
    if (!want && Object.hasOwn(stored, locId(loc))) writes[locId(loc)] = null;
  }
  return writes;
}
