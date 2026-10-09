import "server-only";

import type { BrowserContext, Page, Request, Route } from "playwright-core";
import { publicFetch, type PublicFetchInit } from "@/lib/webhooks/public-fetch";
import { NonPublicUrlError } from "@/lib/webhooks/validate-url";
import { sameSite } from "@/lib/prospecting/registrable-domain";
import { CAPTCHA_URL } from "./page-scan";
import { carriesEnquiry, rejectionOf, type EnquiryMarkers } from "./evidence";

/**
 * The browser never opens a network connection itself. Every http(s) request
 * it makes is performed here, in Node, by `fetchImpl` (publicFetch: the
 * address is checked inside the socket's DNS lookup, and redirects are never
 * followed) and handed back with `route.fulfill`. Anything else is aborted:
 * other schemes, images / media / fonts / beacons, WebSockets, CAPTCHA
 * providers. The launch's dead proxy (browser.ts) is the backstop if a
 * request ever slipped past the route.
 *
 * Redirects are followed HERE, one hop at a time, each hop through
 * `fetchImpl` again: a 3xx fulfilled to Chromium would be followed by the
 * browser's own network stack, bypassing the route. A main-frame 3xx is
 * not fulfilled at all: the navigation is cancelled (204) and the Location
 * recorded, so engine.ts decides whether to go there (that counts as the one
 * allowed redirect) — after the submit click it is the confirmation signal.
 *
 * Only the default ports (80 / 443) on every request and hop. A job's budget
 * keeps a hostile page from filling this process's memory: at most
 * MAX_IN_FLIGHT requests at once (the rest wait), MAX_REQUESTS in all and
 * MAX_TOTAL_BYTES of responses; past it every request is aborted, and a main
 * document refused for it marks the page too heavy. After the click, a
 * request carrying the enquiry (evidence.ts) is what the confirmation signals
 * hang on: its status, and a 2xx body that says the site rejected it.
 */

export type FetchImpl = (url: string, init: PublicFetchInit) => Promise<Response>;

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Initial document + one redirect, before the submit. */
export const MAX_MAIN_DOCUMENTS = 2;
const SUBRESOURCE_REDIRECTS = 3;
export const MAX_IN_FLIGHT = 6;
export const MAX_REQUESTS = 150;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const ALLOWED_TYPES = new Set(["document", "script", "xhr", "fetch", "stylesheet"]);
/** Hop-by-hop and framing headers: Node sets its own; an encoded body is never asked for (no decoding here). */
const DROP_REQUEST = new Set([
  "connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding",
  "upgrade", "host", "content-length", "accept-encoding",
]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie"]);
/** Third-party form backends whose 2xx to a POST counts as a submission. */
const FORM_BACKENDS =
  /(^|\.)(formspree\.io|getform\.io|hsforms\.com|jotform\.com|typeform\.com|formsubmit\.co|web3forms\.com|usebasin\.com|formcarry\.com|wufoo\.com|zohopublic\.com)$/i;

export interface GuardState {
  /** Set when a main-frame document was refused (not a public address / not http(s)). */
  blocked: string | null;
  /** Set when a main-frame document could not be fetched for any other reason. */
  fetchError: string | null;
  /** Main-frame document requests before the click. */
  mainDocuments: number;
  tooManyRedirects: boolean;
  /** A main-frame 3xx's Location (absolute), waiting for engine.ts. */
  redirect: string | null;
  /** The first CAPTCHA / challenge seen on the wire. */
  captcha: string | null;
  /** Set by engine.ts just before the submit click. */
  clickedAt: number | null;
  /** After the click: POSTs that went out (or may have: anything but a refused address). */
  postsOut: number;
  /** After the click: a 2xx to a request carrying the enquiry, same site or a known backend. */
  postOk: string | null;
  /** After the click: a request carrying the enquiry was answered 2xx/3xx (its URL). */
  carrierOk: string | null;
  /** After the click: a 2xx answer to the enquiry that says the site refused it. */
  rejected: string | null;
  /** The job's budget: requests routed, response bytes, and whether a main document hit it. */
  requests: number;
  bytes: number;
  tooHeavy: boolean;
  /** After the click: a main-frame navigation answered (2xx/3xx) at a URL other than `formUrl`. */
  navigatedTo: string | null;
  /** The form page's URL once loaded (engine.ts). */
  formUrl: string | null;
}

export function newGuardState(): GuardState {
  return {
    blocked: null, fetchError: null, mainDocuments: 0, tooManyRedirects: false, redirect: null, captcha: null,
    clickedAt: null, postsOut: 0, postOk: null, carrierOk: null, rejected: null, requests: 0, bytes: 0, tooHeavy: false,
    navigatedTo: null, formUrl: null,
  };
}

const httpish = (u: URL) => u.protocol === "http:" || u.protocol === "https:";

export interface GuardOptions {
  fetchImpl: FetchImpl;
  signal: AbortSignal;
  state: GuardState;
  /** Our email and message (evidence.ts). */
  markers: EnquiryMarkers;
  /** Test-only: explicit ports allowed besides the defaults (the local fixture's). */
  allowPorts?: string[];
}

class OverBudget extends Error {}

/** A refused port, like a refused address: never connected to. */
const portOk = (u: URL, allow: string[] | undefined) => u.port === "" || (allow ?? []).includes(u.port);

function isMainFrame(page: Page, req: Request): boolean {
  try {
    return req.isNavigationRequest() && req.frame() === page.mainFrame();
  } catch {
    // A request with no frame (a service worker's) is never the main document.
    return false;
  }
}

/** One request, redirects (for a sub-resource) followed hop by hop through `fetchImpl`. */
async function fetchHops(
  req: Request,
  opts: GuardOptions,
  hops: number,
): Promise<{ res: Response; url: string; body: Buffer }> {
  const { fetchImpl, signal, state } = opts;
  let url = req.url();
  let method = req.method();
  let body: Buffer | undefined = req.postDataBuffer() ?? undefined;
  const headers = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([k]) => !DROP_REQUEST.has(k)));
  for (let i = 0; ; i++) {
    const posting = method === "POST" && state.clickedAt !== null;
    const left = MAX_TOTAL_BYTES - state.bytes;
    if (++state.requests > MAX_REQUESTS || left <= 0) throw new OverBudget("over the request budget");
    let res: Response;
    let data: Buffer;
    try {
      res = await fetchImpl(url, { method, headers, body, signal, maxBytes: Math.min(MAX_BODY_BYTES, left) });
      data = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      // A refused address was never connected to; any other error may have delivered the POST.
      if (posting && !(err instanceof NonPublicUrlError)) state.postsOut++;
      if (left < MAX_BODY_BYTES && /too large/i.test(String(err))) throw new OverBudget("over the byte budget");
      throw err;
    }
    state.bytes += data.length;
    if (posting) state.postsOut++;
    const location = res.headers.get("location");
    if (res.status < 300 || res.status > 399 || !location || i >= hops) return { res, url, body: data };
    const next = new URL(location, url);
    if (!httpish(next) || !portOk(next, opts.allowPorts)) throw new NonPublicUrlError(next.host || next.protocol);
    if (res.status <= 303 && method !== "GET" && method !== "HEAD") {
      method = "GET";
      body = undefined;
    }
    url = next.href;
  }
}

async function fulfill(route: Route, res: Response, body: Buffer) {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (!DROP_RESPONSE.has(k)) headers[k] = v;
  });
  // Playwright splits a newline-joined Set-Cookie back into one header per cookie.
  const cookies = res.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies.join("\n");
  await route.fulfill({ status: res.status, headers, body });
}

/** Route every request of `context` through `fetchImpl`; `state` records what engine.ts needs to know. */
export async function installNetworkGuard(context: BrowserContext, page: Page, opts: GuardOptions): Promise<void> {
  const { signal, state } = opts;
  // At most MAX_IN_FLIGHT fetches at once; the rest wait their turn (all released on abort).
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  const acquire = () => (inFlight < MAX_IN_FLIGHT ? (inFlight++, Promise.resolve()) : new Promise<void>((r) => waiting.push(r)));
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  };
  signal.addEventListener("abort", () => waiting.splice(0).forEach((r) => r()), { once: true });
  await context.routeWebSocket(/.*/, (ws) => ws.close());
  await context.route("**/*", async (route) => {
    const req = route.request();
    const main = isMainFrame(page, req);
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      return route.abort("blockedbyclient");
    }
    if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    if (!httpish(url)) {
      if (main) state.blocked = `${url.protocol} is not allowed`;
      return route.abort("blockedbyclient");
    }
    if (!portOk(url, opts.allowPorts)) {
      if (main) state.blocked = `port ${url.port} is not allowed`;
      return route.abort("blockedbyclient");
    }
    if (CAPTCHA_URL.test(url.href)) {
      state.captcha ??= `captcha request: ${url.hostname}`;
      return route.abort("blockedbyclient");
    }
    if (!ALLOWED_TYPES.has(req.resourceType())) return route.abort("blockedbyclient");
    if (main && state.clickedAt === null && ++state.mainDocuments > MAX_MAIN_DOCUMENTS) {
      state.tooManyRedirects = true;
      return route.abort("blockedbyclient");
    }
    const afterClick = state.clickedAt !== null;
    // Started after the click and carrying our email or message: the enquiry itself.
    const carrier = afterClick && carriesEnquiry(`${req.url()}\n${req.postDataBuffer()?.toString("utf8") ?? ""}`, opts.markers);
    await acquire();
    try {
      if (signal.aborted) throw new Error("aborted");
      const { res, url: finalUrl, body } = await fetchHops(req, opts, main ? 0 : SUBRESOURCE_REDIRECTS);
      if (main && res.headers.get("cf-mitigated")) state.captcha ??= "Cloudflare challenge response";
      const host = new URL(finalUrl).hostname;
      const known = state.formUrl !== null && (sameSite(host, new URL(state.formUrl).hostname) || FORM_BACKENDS.test(host));
      if (carrier && res.status >= 200 && res.status < 400) state.carrierOk ??= finalUrl;
      if (carrier && res.status >= 200 && res.status < 300) {
        state.rejected ??= rejectionOf(body.subarray(0, 64 * 1024).toString("utf8"));
        if (known) state.postOk ??= finalUrl;
      }
      if (main && res.status >= 300 && res.status <= 399) {
        const location = res.headers.get("location");
        const next = location ? new URL(location, finalUrl) : null;
        if (next && (!httpish(next) || !portOk(next, opts.allowPorts))) state.blocked = `redirect to ${next.protocol}//${next.host} is not allowed`;
        else if (next) state.redirect = next.href;
        if (afterClick && next && httpish(next) && next.href !== state.formUrl) state.navigatedTo ??= next.href;
        return await route.fulfill({ status: 204, body: "" });
      }
      if (main && afterClick && res.status < 400 && finalUrl !== state.formUrl) state.navigatedTo ??= finalUrl;
      return await fulfill(route, res, body);
    } catch (err) {
      const refused = err instanceof NonPublicUrlError;
      if (err instanceof OverBudget && main) state.tooHeavy = true;
      else if (main && refused) state.blocked = err.message;
      else if (main) state.fetchError ??= err instanceof Error ? err.message : String(err);
      return route.abort(refused ? "blockedbyclient" : signal.aborted ? "timedout" : "failed").catch((e: unknown) => {
        // The page may already be closed (timeout): nothing left to answer.
        if (!signal.aborted) console.error("[mystery-shop/form] route abort failed", e);
      });
    } finally {
      release();
    }
  });
}

export const defaultFetch: FetchImpl = (url, init) => publicFetch(url, init);
