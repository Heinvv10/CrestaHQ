import { cert } from "firebase-admin/app";

/**
 * The Google OAuth token the rules tests (`pnpm test:rules`) send to the
 * Rules test API. The self-hosted CI box's egress intermittently stalls
 * (ETIMEDOUT to oauth2.googleapis.com failed CI twice on 2026-10-05), so the
 * mint is retried: a network error, or an attempt still unsettled after
 * ATTEMPT_MS, is retried with backoff; anything else (a bad key) fails at
 * once. The retry is the fix. The cache only dedupes calls within one test
 * file: vitest isolates each file's modules, and each rules file calls
 * evaluate() once, in beforeAll, so a run still mints one token per file.
 * The whole budget (MAX_TOKEN_MS) fits the hookTimeout in
 * vitest.rules.config.mts. Imported relatively: that config has no `@` alias.
 */

type Creds = { projectId?: string; clientEmail?: string; privateKey?: string };

const NETWORK_CODES = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);
const ATTEMPTS = 4;
const ATTEMPT_MS = 10_000;
const BACKOFF_MS = 1000;
/** Worst case: every attempt hangs to ATTEMPT_MS, plus 1 + 2 + 4 s backoff. */
export const MAX_TOKEN_MS = ATTEMPTS * ATTEMPT_MS + BACKOFF_MS * (2 ** (ATTEMPTS - 1) - 1);

let token: Promise<string> | null = null;

/** A transport failure (on the error or any `cause`), not a refusal. */
export function isNetworkError(err: unknown): boolean {
  for (let e = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if (NETWORK_CODES.has(String((e as { code?: unknown }).code))) return true;
  }
  return false;
}

/** One mint, given up on (as ETIMEDOUT) once it has hung for ATTEMPT_MS. */
async function attemptMint(creds: Creds): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`token request unanswered after ${ATTEMPT_MS} ms`), { code: "ETIMEDOUT" })),
      ATTEMPT_MS,
    );
  });
  try {
    return (await Promise.race([cert(creds as Required<Creds>).getAccessToken(), hung])).access_token;
  } finally {
    clearTimeout(timer);
  }
}

async function mint(creds: Creds): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptMint(creds);
    } catch (err) {
      if (attempt >= ATTEMPTS || !isNetworkError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * 2 ** (attempt - 1)));
    }
  }
}

/** This file's token; a failed mint is forgotten, so a later call retries. */
export function rulesAccessToken(creds: Creds): Promise<string> {
  token ??= mint(creds).catch((err: unknown) => {
    token = null;
    throw err;
  });
  return token;
}
