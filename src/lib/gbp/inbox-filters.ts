import { toMillis } from "./sync/types";

/**
 * The reviews inbox filters: `rating` (comma list 1–5), `replied`
 * (`all|replied|unreplied`), `from` / `to` on createTime, `sort` (`newest` |
 * `oldest`). Applied in memory to the capped newest-first set the route
 * already reads — no composite index.
 *
 * `from` is inclusive, `to` exclusive. Each is an ISO date-time with an
 * offset — the page sends the viewer's LOCAL midnights (from = local 00:00 of
 * the first day, to = local 00:00 after the last), so the days match the
 * local dates the list shows — or a bare ISO date, read as that UTC day (a
 * date-only `to` covers the whole of that UTC day). A present-but-empty value
 * is ignored (a blank date input sends one); anything else malformed is
 * refused with its field name.
 */

export interface ReviewFilters {
  ratings: Set<number> | null;
  replied: "all" | "replied" | "unreplied";
  fromMs: number | null;
  /** Exclusive upper bound. */
  toMs: number | null;
  sort: "newest" | "oldest";
}

export type ParsedFilters = { ok: true; filters: ReviewFilters } | { ok: false; field: string };

const DAY_MS = 24 * 3600_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Epoch ms of an ISO date or date-time; a date-only value is that UTC midnight. Null when invalid. */
function parseDate(v: string): { ms: number; dateOnly: boolean } | null {
  const d = DATE_ONLY.exec(v);
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const ms = Date.UTC(y, m - 1, day);
    const back = new Date(ms);
    // Date.UTC rolls 2026-02-31 over to March — refuse instead.
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== day) return null;
    return { ms, dateOnly: true };
  }
  if (!DATE_TIME.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : { ms, dateOnly: false };
}

export function parseReviewFilters(params: URLSearchParams): ParsedFilters {
  const get = (name: string) => {
    const v = params.get(name);
    return v === null || v === "" ? null : v;
  };

  let ratings: Set<number> | null = null;
  const rating = get("rating");
  if (rating !== null) {
    ratings = new Set();
    for (const part of rating.split(",")) {
      if (!/^[1-5]$/.test(part)) return { ok: false, field: "rating" };
      ratings.add(Number(part));
    }
  }

  const replied = get("replied") ?? "all";
  if (replied !== "all" && replied !== "replied" && replied !== "unreplied") return { ok: false, field: "replied" };

  const sort = get("sort") ?? "newest";
  if (sort !== "newest" && sort !== "oldest") return { ok: false, field: "sort" };

  let fromMs: number | null = null;
  const from = get("from");
  if (from !== null) {
    const p = parseDate(from);
    if (!p) return { ok: false, field: "from" };
    fromMs = p.ms;
  }
  let toMs: number | null = null;
  const to = get("to");
  if (to !== null) {
    const p = parseDate(to);
    if (!p) return { ok: false, field: "to" };
    toMs = p.dateOnly ? p.ms + DAY_MS : p.ms;
  }
  if (fromMs !== null && toMs !== null && fromMs >= toMs) return { ok: false, field: "to" };

  return { ok: true, filters: { ratings, replied, fromMs, toMs, sort } };
}

/** Filter + order stored review docs (already newest first by createTime). */
export function applyReviewFilters<T extends Record<string, unknown>>(docs: T[], f: ReviewFilters): T[] {
  const out = docs.filter((d) => {
    if (f.ratings && !f.ratings.has(Number(d.starRating))) return false;
    if (f.replied === "replied" && !d.reply) return false;
    if (f.replied === "unreplied" && d.reply) return false;
    const created = toMillis(d.createTime);
    if (f.fromMs !== null && (created === null || created < f.fromMs)) return false;
    if (f.toMs !== null && (created === null || created >= f.toMs)) return false;
    return true;
  });
  return f.sort === "oldest" ? out.reverse() : out;
}
