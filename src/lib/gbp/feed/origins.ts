/**
 * Validation for the public reviews widget config (PUT …/gbp/widget). Pure,
 * so the browser card can show the same reasons the server gives.
 *
 * An allowed origin is exactly what a browser sends in `Origin`:
 * `scheme://host[:port]` — so the feed can compare with `===`. https only,
 * except plain http on `localhost` / `127.0.0.1` for local development. No
 * paths, queries, fragments, wildcards or credentials.
 *
 * There is deliberately NO rating filter: an unknown field (`minRating`
 * included) is refused, not ignored, so nobody can believe one is in force.
 */

export const MAX_ORIGINS = 10;
export const MAX_REVIEWS_LIMIT = 50;
export const DEFAULT_MAX_REVIEWS = 12;

export type OriginReason =
  | "not_a_string"
  | "not_a_url"
  | "wildcard"
  | "credentials"
  | "path"
  | "https_required"
  | "scheme";

export type OriginResult = { ok: true; origin: string } | { ok: false; reason: OriginReason };

export function normalizeOrigin(input: unknown): OriginResult {
  if (typeof input !== "string") return { ok: false, reason: "not_a_string" };
  const raw = input.trim();
  if (raw.includes("*")) return { ok: false, reason: "wildcard" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not_a_url" };
  }
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (url.pathname !== "/" || url.search || url.hash) return { ok: false, reason: "path" };
  if (url.protocol === "https:") return { ok: true, origin: url.origin };
  if (url.protocol !== "http:") return { ok: false, reason: "scheme" };
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return loopback ? { ok: true, origin: url.origin } : { ok: false, reason: "https_required" };
}

export interface WidgetConfig {
  enabled: boolean;
  allowedOrigins: string[];
  maxReviews: number;
}

export type WidgetConfigResult =
  | { ok: true; config: WidgetConfig }
  | {
      ok: false;
      code: "invalid_body" | "invalid_origins" | "too_many_origins";
      error: string;
      details?: Array<{ index: number; value: string; reason: OriginReason }>;
    };

const KEYS = new Set(["enabled", "allowedOrigins", "maxReviews"]);
const invalid = (error: string): WidgetConfigResult => ({ ok: false, code: "invalid_body", error });

export function parseWidgetConfig(body: unknown): WidgetConfigResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return invalid("Expected a JSON object.");
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => !KEYS.has(k));
  if (unknown !== undefined) return invalid(`Unknown field: ${unknown}.`);
  if (typeof b.enabled !== "boolean") return invalid("enabled must be true or false.");
  if (!Array.isArray(b.allowedOrigins)) return invalid("allowedOrigins must be a list.");
  const max = b.maxReviews === undefined ? DEFAULT_MAX_REVIEWS : b.maxReviews;
  if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > MAX_REVIEWS_LIMIT) {
    return invalid(`maxReviews must be a whole number from 1 to ${MAX_REVIEWS_LIMIT}.`);
  }
  if (b.allowedOrigins.length > MAX_ORIGINS) {
    return { ok: false, code: "too_many_origins", error: `At most ${MAX_ORIGINS} allowed origins.` };
  }

  const origins: string[] = [];
  const details: Array<{ index: number; value: string; reason: OriginReason }> = [];
  b.allowedOrigins.forEach((value, index) => {
    const r = normalizeOrigin(value);
    if (!r.ok) details.push({ index, value: String(value), reason: r.reason });
    else if (!origins.includes(r.origin)) origins.push(r.origin);
  });
  if (details.length > 0) {
    return { ok: false, code: "invalid_origins", error: "Some allowed origins are not valid.", details };
  }
  return { ok: true, config: { enabled: b.enabled, allowedOrigins: origins, maxReviews: max as number } };
}
