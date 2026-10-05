import { cert } from "firebase-admin/app";

/**
 * The Google OAuth token the rules tests (`pnpm test:rules`) send to the
 * Rules test API: minted once per test process and shared by every
 * `evaluate()` call in it. Minting one per call put dozens of parallel
 * requests on oauth2.googleapis.com, and the self-hosted CI box's egress
 * intermittently stalls (ETIMEDOUT failed CI twice on 2026-10-05). A network
 * error is retried with backoff; anything else (a bad key) fails at once.
 * Imported relatively: vitest.rules.config.mts has no `@` alias.
 */

type Creds = { projectId?: string; clientEmail?: string; privateKey?: string };

const NETWORK_CODES = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);
const ATTEMPTS = 4;
const BACKOFF_MS = 1000;

let token: Promise<string> | null = null;

/** A transport failure (on the error or any `cause`), not a refusal. */
export function isNetworkError(err: unknown): boolean {
  for (let e = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if (NETWORK_CODES.has(String((e as { code?: unknown }).code))) return true;
  }
  return false;
}

async function mint(creds: Creds): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await cert(creds as Required<Creds>).getAccessToken()).access_token;
    } catch (err) {
      if (attempt >= ATTEMPTS || !isNetworkError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * 2 ** (attempt - 1)));
    }
  }
}

/** This process's token; a failed mint is forgotten, so a later call retries. */
export function rulesAccessToken(creds: Creds): Promise<string> {
  token ??= mint(creds).catch((err: unknown) => {
    token = null;
    throw err;
  });
  return token;
}
