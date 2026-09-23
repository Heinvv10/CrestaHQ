import "server-only";

import http from "node:http";
import https from "node:https";
import {
  NonPublicUrlError,
  publicLookup,
  resolvePublicAddresses,
  ssrfGuardEnabled,
} from "@/lib/webhooks/validate-url";

/**
 * `fetch` for URLs a tenant controls (webhook destinations, integration base
 * URLs, logos). Differences from global fetch, all deliberate:
 *
 *   - In production the connection only opens to public addresses: the check
 *     runs inside the socket's DNS lookup (`publicLookup`), so the address
 *     validated is the address connected to — no rebinding window.
 *   - Redirects are never followed; a 3xx comes back as the response. A
 *     public URL redirecting to an internal one is the classic bypass of a
 *     check made only on the first URL.
 *   - The response body is capped at `MAX_RESPONSE_BYTES`.
 *
 * Throws `NonPublicUrlError` (via the lookup, or directly for IP literals,
 * which never reach a lookup) when the destination is refused.
 */

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export interface PublicFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export async function publicFetch(
  input: string,
  init: PublicFetchInit = {},
): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NonPublicUrlError(url.hostname || input);
  }
  const guard = ssrfGuardEnabled();
  // IP literals skip the socket lookup entirely, so check them (and
  // `localhost`-style names) up front.
  if (guard) await resolvePublicAddresses(url.hostname);

  const mod = url.protocol === "https:" ? https : http;
  return new Promise<Response>((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: init.method ?? "GET",
        headers: init.body !== undefined
          ? { ...init.headers, "Content-Length": String(Buffer.byteLength(init.body)) }
          : init.headers,
        signal: init.signal,
        // No shared agent: a pooled socket opened by an unguarded request
        // must never be reused here.
        agent: false,
        ...(guard ? { lookup: publicLookup } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("Response body too large."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const status = res.statusCode ?? 0;
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (v === undefined) continue;
              for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
            }
            resolve(
              new Response(
                NULL_BODY_STATUSES.has(status)
                  ? null
                  : new Uint8Array(Buffer.concat(chunks)),
                { status, statusText: res.statusMessage, headers },
              ),
            );
          } catch (err) {
            // e.g. a status outside 200–599, which Response refuses.
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
