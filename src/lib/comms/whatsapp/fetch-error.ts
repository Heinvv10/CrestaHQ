/**
 * Classifies what `fetch` threw against Graph: whether the request can have
 * left this box, and a log-safe description of the failure.
 *
 * undici throws `TypeError("fetch failed")` with the socket error on `cause`.
 */

/**
 * Codes that mean no connection was ever made, so the request body cannot
 * have reached Meta and a retry cannot double-message. Everything else (a
 * reset, a socket error, a timeout after connecting) may have been delivered
 * and stays AMBIGUOUS. ETIMEDOUT, EHOSTUNREACH and ENETUNREACH are left out on
 * purpose: Linux also raises them on an established socket.
 */
const PRE_CONNECT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
]);

interface SubError {
  code?: unknown;
  syscall?: unknown;
}

interface FetchCause extends SubError {
  name?: unknown;
  errors?: unknown;
}

export interface FetchFailure {
  code: string | null;
  /** True only when the request provably never left: safe to retry. */
  preConnect: boolean;
  /** `name=… code=…` plus `cause=` / `errors=` when present. No URL, body or token. */
  detail: string;
}

export function classifyFetchError(e: unknown): FetchFailure {
  const err = e as (FetchCause & { cause?: FetchCause }) | null | undefined;
  const cause = err?.cause;
  const rawCode = cause?.code ?? err?.code;
  const code = typeof rawCode === "string" ? rawCode : null;

  // Node's happy-eyeballs connect (autoSelectFamily, on by default in 22)
  // destroys the socket with an AggregateError when every address fails. Its
  // `code` is the first address's code, which can be ETIMEDOUT, but every
  // entry is a `connect` syscall error: the socket never connected. A timeout
  // on an established socket is a plain Error with syscall `read` or `write`.
  // Both shapes were reproduced on Node 22.23.1 before this was written.
  const subErrors = Array.isArray(cause?.errors)
    ? (cause.errors as SubError[])
    : [];
  const allConnectFailures =
    cause?.name === "AggregateError" &&
    subErrors.length > 0 &&
    subErrors.every((s) => s?.syscall === "connect");

  const errors = subErrors
    .map((s) => `${String(s?.code)}:${String(s?.syscall)}`)
    .join(",");
  const detail =
    `name=${e instanceof Error ? e.name : typeof e} code=${code ?? "none"}` +
    (cause && typeof cause.name === "string" ? ` cause=${cause.name}` : "") +
    (errors ? ` errors=${errors}` : "");

  return {
    code,
    preConnect:
      allConnectFailures || (code !== null && PRE_CONNECT_CODES.has(code)),
    detail,
  };
}
