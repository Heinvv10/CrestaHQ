import { FETCH_TIMEOUT_MS } from "./fetch-timeout.ts";

/**
 * LeadStack answers a burst of calls with HTTP 429 (`Retry-After` header, or
 * "Retry after Ns." in the JSON body). One run makes ~50 calls, so without a
 * backoff most of them fail and the run exits 1. Every attempt gets its own
 * FETCH_TIMEOUT_MS abort signal; non-429 responses and network errors pass
 * through unchanged.
 */
export const MAX_RETRIES = 3;
const DEFAULT_DELAY_MS = 2_000;
const MAX_DELAY_MS = 10_000;

export type LeadstackFetch = (url: string, init?: Omit<RequestInit, "signal">) => Promise<Response>;

export function leadstackFetch(
  fetchImpl: typeof fetch = fetch,
  opts: { sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {},
): LeadstackFetch {
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return async (url, init) => {
    let res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    for (let attempt = 0; attempt < MAX_RETRIES && res.status === 429; attempt++) {
      const delayMs = await retryDelayMs(res);
      opts.log?.(`429 from ${url}; retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`);
      await sleep(delayMs);
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    }
    return res;
  };
}

async function retryDelayMs(res: Response): Promise<number> {
  const header = Number(res.headers.get("retry-after"));
  let seconds = Number.isFinite(header) && header > 0 ? header : NaN;
  if (Number.isNaN(seconds)) {
    // Consume the body so the retried request doesn't leave a stream dangling.
    const body = await res.clone().text().catch(() => "");
    const m = /retry after (\d+(?:\.\d+)?)s/i.exec(body);
    seconds = m ? Number(m[1]) : NaN;
  }
  const ms = Number.isNaN(seconds) ? DEFAULT_DELAY_MS : seconds * 1000;
  return Math.min(ms, MAX_DELAY_MS);
}
