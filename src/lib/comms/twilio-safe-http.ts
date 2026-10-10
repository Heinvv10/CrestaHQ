import RequestClient, { type RequestOptions } from "twilio/lib/base/RequestClient";
import type Response from "twilio/lib/http/response";

/**
 * twilio-node rethrows the raw AxiosError on a transport failure (timeout,
 * reset, DNS). That object carries `config.headers.Authorization` =
 * `Basic base64(accountSid:authToken)`, so any `console.*(…, err)` anywhere
 * downstream writes the credential to the server log. Non-2xx Twilio answers
 * are NOT affected: they resolve here and the SDK builds a clean RestException.
 *
 * Only these fields leave this module. `code` carries the Twilio error number
 * (21610 opt-out is read in sendSmsForSubAccount) or the transport code
 * (ECONNRESET, ECONNABORTED); `status` is the HTTP status when present.
 * `config`, `request`, `response` and every header object are dropped.
 */
export function sanitizeTwilioTransportError(err: unknown): Error {
  if (typeof err !== "object" || err === null) {
    return new Error(typeof err === "string" ? err : "Twilio request failed");
  }
  const src = err as { name?: unknown; message?: unknown; code?: unknown; status?: unknown; stack?: unknown };
  const safe = new Error(typeof src.message === "string" ? src.message : "Twilio request failed");
  if (typeof src.name === "string") safe.name = src.name;
  if (typeof src.stack === "string") safe.stack = src.stack;
  if (typeof src.code === "string" || typeof src.code === "number") {
    Object.defineProperty(safe, "code", { value: src.code, enumerable: true, writable: true, configurable: true });
  }
  if (typeof src.status === "number") {
    Object.defineProperty(safe, "status", { value: src.status, enumerable: true, writable: true, configurable: true });
  }
  return safe;
}

/**
 * Passed as `httpClient` to every `twilio(sid, token, …)` this app builds.
 * Passing `httpClient` makes the SDK skip constructing its own default client,
 * so any client options (timeout, autoRetry, maxRetries, ca, region) must be
 * given to `new SafeTwilioRequestClient({...})`, NOT to `twilio(sid, token, {...})`.
 */
export class SafeTwilioRequestClient extends RequestClient {
  override async request<TData>(opts: RequestOptions<TData>): Promise<Response<TData>> {
    try {
      return await super.request<TData>(opts);
    } catch (err) {
      throw sanitizeTwilioTransportError(err);
    }
  }
}
