import type { AutoReplyMode, AutoReplyStar, ReviewsAutoReplySettings } from "@/types";

/**
 * Review auto-reply settings (AUTO_REPLY_V1_PLAN.md, PR 1): the shape stored
 * at `subAccounts/{id}.reviewsAutoReply`, its defaults, the strict PUT body
 * parser and the off→on stamping. Pure — the route owns auth, gates and the
 * transaction. Nothing here drafts or posts.
 */

export const AUTO_REPLY_STARS: readonly AutoReplyStar[] = [1, 2, 3, 4, 5];

/** Shown read-only on the settings card; enforced by the engine (PR 2). */
export const AUTO_REPLY_DAILY_POST_CAP = 20;
export const AUTO_REPLY_DAILY_DRAFT_CAP = 40;

/**
 * The engine that acts on these settings does not exist yet (PR 2), so the
 * route refuses `enabled: true` with 409 `not_available` while this is false.
 * PR 2 flips it.
 */
export const AUTO_REPLY_ENGINE_AVAILABLE = false;

export const DEFAULT_AUTO_REPLY_MODES: Readonly<Record<AutoReplyStar, AutoReplyMode>> = {
  1: "approval",
  2: "approval",
  3: "approval",
  4: "auto",
  5: "auto",
};

/** What an admin may send: exactly these three keys, nothing else. */
export interface AutoReplyInput {
  enabled: boolean;
  modes: Record<AutoReplyStar, AutoReplyMode>;
  includeBacklog: boolean;
}

const BODY_KEYS = ["enabled", "includeBacklog", "modes"];
const STAR_KEYS = ["1", "2", "3", "4", "5"];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isMode = (v: unknown): v is AutoReplyMode => v === "auto" || v === "approval";
const sameKeys = (obj: Record<string, unknown>, keys: string[]) => {
  const got = Object.keys(obj).sort();
  return got.length === keys.length && got.every((k, i) => k === keys[i]);
};

/** The PUT body, or null when it is anything but the exact allow-listed shape. */
export function parseAutoReplyBody(body: unknown): AutoReplyInput | null {
  if (!isPlainObject(body) || !sameKeys(body, BODY_KEYS)) return null;
  const { enabled, includeBacklog, modes } = body;
  if (typeof enabled !== "boolean" || typeof includeBacklog !== "boolean") return null;
  if (!isPlainObject(modes) || !sameKeys(modes, STAR_KEYS)) return null;
  if (!STAR_KEYS.every((k) => isMode(modes[k]))) return null;
  const parsed = {} as Record<AutoReplyStar, AutoReplyMode>;
  for (const star of AUTO_REPLY_STARS) parsed[star] = modes[String(star)] as AutoReplyMode;
  return { enabled, includeBacklog, modes: parsed };
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

export type NextSettings =
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
  const isStamp = (x: unknown): x is Date => x !== null && x !== undefined && typeof x === "object";
  return {
    ok: true,
    value: {
      enabled: input.enabled,
      modes: input.modes,
      includeBacklog: input.includeBacklog,
      enabledAt: turningOn ? ctx.now : kept(p.enabledAt, isStamp),
      enabledByUid: turningOn ? ctx.uid : kept(p.enabledByUid, isString),
      listingLocationName: turningOn ? ctx.listingLocationName : kept(p.listingLocationName, isString),
      updatedAt: ctx.now,
      updatedByUid: ctx.uid,
    },
  };
}
