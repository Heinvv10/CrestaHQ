import "server-only";

import { GbpProviderError } from "./types";

/**
 * The one place Google HTTP responses become typed results or typed errors.
 *
 * Bodies are READ (to classify a 403, to parse JSON) but never copied into an
 * error: Google echoes request detail in error messages, and an error message
 * is exactly the thing that ends up in a log line or an API response.
 */

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim()) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** A 403 that means "the token lacks the scope", not "you lack the listing". */
function isScopeInsufficient(body: unknown): boolean {
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!error || typeof error !== "object") return false;
  const details = Array.isArray(error.details) ? error.details : [];
  if (
    details.some(
      (d) => (d as { reason?: unknown })?.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
    )
  ) {
    return true;
  }
  return (
    typeof error.message === "string" &&
    /insufficient authentication scopes/i.test(error.message)
  );
}

export function errorForStatus(res: Response, body: unknown): GbpProviderError {
  const status = res.status;
  if (status === 401) return new GbpProviderError("auth_expired", { status });
  if (status === 403) {
    return new GbpProviderError(
      isScopeInsufficient(body) ? "insufficient_scope" : "permission_denied",
      { status },
    );
  }
  if (status === 404) return new GbpProviderError("not_found", { status });
  if (status === 429) {
    return new GbpProviderError("rate_limited", { status, retryAfterMs: retryAfterMs(res) });
  }
  if (status >= 500) return new GbpProviderError("transient", { status });
  // Any other 4xx: Google rejected the request as we shaped it.
  return new GbpProviderError("malformed", { status });
}

/** fetch + JSON parse with every failure mapped to a GbpProviderError. */
export async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new GbpProviderError("transient");
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    // A body that dies mid-read must not read as an empty success page.
    throw new GbpProviderError("transient", { status: res.status });
  }
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON. An error status is classified by status alone; on a 2xx the
      // null reaches the parser, which fails closed with `malformed`.
      body = null;
    }
  }
  if (!res.ok) throw errorForStatus(res, body);
  return body;
}

export function bearer(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}
