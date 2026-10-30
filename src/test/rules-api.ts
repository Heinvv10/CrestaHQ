import { cert } from "firebase-admin/app";

/**
 * The network calls the rules tests (`pnpm test:rules`) make: the Google
 * OAuth token and the Rules test API evaluation. Egress from CI to Google
 * intermittently failed to connect (observed from the then self-hosted CI
 * box; ETIMEDOUT to oauth2.googleapis.com, UND_ERR_CONNECT_TIMEOUT to
 * firebaserules.googleapis.com, ~10% of connects on 2026-10-05), so both go
 * through one retry policy: a network error, or an attempt still unanswered
 * after ATTEMPT_MS, is retried with backoff. Anything else fails at once: a
 * bad key, and EVERY HTTP response, 4xx or 5xx, which the caller sees as
 * is, so a rules failure stays a failure. Retrying is safe: the evaluation
 * is a read-only test run. The token cache only dedupes calls within one
 * test file (vitest isolates each file's modules; each file calls
 * evaluate() once, in beforeAll). Imported relatively: vitest.rules.config.mts
 * has no `@` alias, and its hookTimeout covers MAX_EVALUATE_MS.
 */

type Creds = { projectId?: string; clientEmail?: string; privateKey?: string };

const NETWORK_CODES = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);
const ATTEMPTS = 4;
const ATTEMPT_MS = 15_000;
const BACKOFF_MS = 1000;
/** One retried call's worst case: every attempt hangs to ATTEMPT_MS, plus 1 + 2 + 4 s backoff. */
const MAX_CALL_MS = ATTEMPTS * ATTEMPT_MS + BACKOFF_MS * (2 ** (ATTEMPTS - 1) - 1);
/** A rules file's beforeAll: the token, then one Rules API call. */
export const MAX_EVALUATE_MS = 2 * MAX_CALL_MS;

let token: Promise<string> | null = null;

/** A transport failure (on the error or any `cause`), not a refusal. */
export function isNetworkError(err: unknown): boolean {
  for (let e = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if (NETWORK_CODES.has(String((e as { code?: unknown }).code))) return true;
  }
  return false;
}

/** One attempt, aborted and failed as ETIMEDOUT once it has hung for ATTEMPT_MS. */
async function attempt<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = Object.assign(new Error(`unanswered after ${ATTEMPT_MS} ms`), { code: "ETIMEDOUT" });
      abort.abort(err);
      reject(err);
    }, ATTEMPT_MS);
  });
  try {
    return await Promise.race([call(abort.signal), hung]);
  } finally {
    clearTimeout(timer);
  }
}

async function withNetworkRetry<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt(call);
    } catch (err) {
      if (n >= ATTEMPTS || !isNetworkError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * 2 ** (n - 1)));
    }
  }
}

/** This file's token; a failed mint is forgotten, so a later call retries. */
export function rulesAccessToken(creds: Creds): Promise<string> {
  token ??= withNetworkRetry(async () => (await cert(creds as Required<Creds>).getAccessToken()).access_token).catch(
    (err: unknown) => {
      token = null;
      throw err;
    },
  );
  return token;
}

/**
 * `fetch`, retried on network errors only. The body is read inside the
 * attempt, so a connection dropped mid-body is retried too; the response
 * handed back, whatever its status, is the one the server sent.
 */
export function rulesFetch(url: string, init: RequestInit): Promise<Response> {
  return withNetworkRetry(async (signal) => {
    const res = await fetch(url, { ...init, signal });
    const text = await res.text();
    return new Response(text === "" ? null : text, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
}
