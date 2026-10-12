import "server-only";

import type { BrowserContext, Page, Request, Route } from "playwright-core";
import { publicFetch, type PublicFetchInit } from "@/lib/webhooks/public-fetch";
import { NonPublicUrlError } from "@/lib/webhooks/validate-url";
import { CAPTCHA_URL } from "./page-scan";
import { carriesEnquiry, carriesMessage, knownHost, rejectionOf, type EnquiryMarkers } from "./evidence";
import { postRedirectGet, repostable, samePage } from "./redirects";

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
 * `fetchImpl` again. Measured on this Chromium build (2026-10-09): a 3xx
 * fulfilled for a MAIN-FRAME document is followed by the browser's own
 * network stack, outside the route (without the dead proxy it reached the
 * target directly); one fulfilled for a SUB-RESOURCE is not followed at all
 * (the script just fails). So a main-frame 3xx is never fulfilled: the
 * navigation is cancelled (204) and the Location recorded, and engine.ts
 * decides whether to go there (that counts as the one allowed redirect) —
 * after the submit click it may be the confirmation signal.
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
const MAX_MAIN_DOCUMENTS = 2;
const SUBRESOURCE_REDIRECTS = 3;
const MAX_IN_FLIGHT = 6;
const MAX_REQUESTS = 150;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const ALLOWED_TYPES = new Set(["document", "script", "xhr", "fetch", "stylesheet"]);
/** Hop-by-hop and framing headers: Node sets its own; an encoded body is never asked for (no decoding here). */
const DROP_REQUEST = new Set([
  "connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding",
  "upgrade", "host", "content-length", "accept-encoding",
]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie"]);
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
  /** After the click: the page a post-redirect-get loaded (2xx HTML, not the form page) — confirmed by its text. */
  prgPage: string | null;
  /** After the click: a 2xx to a request carrying the message, same site or a known backend. */
  postOk: string | null;
  /** After the click: a request carrying the message was answered 2xx/3xx (its URL). */
  carrierOk: string | null;
  /** After the click: a request carrying the message was answered 4xx/5xx — then no signal confirms it (checks.ts). */
  carrierFailed: string | null;
  /** After the click: a 2xx answer to the enquiry (a request carrying the message) that says the site refused it. */
  rejected: string | null;
  /** After the click: such a refusal, but answered after `postOk` — the enquiry had already been taken (checks.ts). */
  refusedLate: string | null;
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
    clickedAt: null, postsOut: 0, prgPage: null, postOk: null, carrierOk: null, rejected: null, refusedLate: null, requests: 0, bytes: 0,
    tooHeavy: false, navigatedTo: null, formUrl: null, carrierFailed: null,
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

/**
 * One request through `fetchImpl`. Redirects: a sub-resource's are followed
 * hop by hop ("follow"); a main document's never ("none", engine.ts decides);
 * the enquiry's for ONE hop only — re-POSTed when `repostable`, or as a GET
 * for a post-redirect-get (`followedGet`, which confirms only under the
 * conditions in the route). Any other 3xx is returned as the answer.
 */
async function fetchHops(
  req: Request,
  opts: GuardOptions,
  policy: "none" | "follow" | "enquiry",
): Promise<{ res: Response; url: string; body: Buffer; followedGet: boolean }> {
  const { fetchImpl, signal, state } = opts;
  const hops = policy === "follow" ? SUBRESOURCE_REDIRECTS : policy === "enquiry" ? 1 : 0;
  let url = req.url();
  let method = req.method();
  let body: Buffer | undefined = req.postDataBuffer() ?? undefined;
  let followedGet = false;
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
    if (res.status < 300 || res.status > 399 || !location || i >= hops) return { res, url, body: data, followedGet };
    const next = new URL(location, url);
    if (!httpish(next) || !portOk(next, opts.allowPorts)) throw new NonPublicUrlError(next.host || next.protocol);
    if (policy === "enquiry") {
      if (postRedirectGet(res.status, new URL(url), next, (host) => knownHost(host, state.formUrl))) {
        method = "GET";
        body = undefined;
        followedGet = true;
      } else if (!repostable(res.status, new URL(url), next)) {
        // Neither: the 3xx itself is the answer (never a confirmation).
        return { res, url, body: data, followedGet };
      }
    } else if (res.status <= 303 && method !== "GET" && method !== "HEAD") {
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
    const text = `${req.url()}\n${req.postDataBuffer()?.toString("utf8") ?? ""}`;
    const carries = carriesEnquiry(text, opts.markers);
    // Before the click nothing of the enquiry may leave (a page capturing fields as they are typed —
    // a partial lead, even when the form is then refused); after it, that request IS the enquiry.
    if (carries && !afterClick) return route.abort("blockedbyclient");
    // Only a request holding the message is the enquiry: a newsletter / email check carries just our address.
    const enquiry = afterClick && carriesMessage(text, opts.markers);
    await acquire();
    try {
      if (signal.aborted) throw new Error("aborted");
      const { res, url: finalUrl, body, followedGet } = await fetchHops(req, opts, carries && afterClick ? "enquiry" : main ? "none" : "follow");
      if (main && res.headers.get("cf-mitigated")) state.captcha ??= "Cloudflare challenge response";
      const host = new URL(finalUrl).hostname;
      const known = knownHost(host, state.formUrl);
      // Post-redirect-get: only a 2xx HTML page that isn't the form page is a candidate, and it confirms
      // only if its VISIBLE text says thank you once loaded (checks.ts). Never a carrierOk on its own.
      if (enquiry && followedGet) {
        const htmlPage = res.status >= 200 && res.status < 300 && /text\/html/i.test(res.headers.get("content-type") ?? "");
        if (main && htmlPage && !samePage(finalUrl, state.formUrl)) {
          state.prgPage ??= finalUrl;
          return await fulfill(route, res, body);
        }
        return main ? await route.fulfill({ status: 204, body: "" }) : await fulfill(route, res, body);
      }
      // Only a 2xx to the enquiry (after at most one re-POST) counts; a 3xx never does.
      if (enquiry && res.status >= 200 && res.status < 300) {
        state.carrierOk ??= finalUrl;
        // A refusal after the site took the enquiry (its own retry, a second endpoint) is never `rejected`: that invites a second one.
        state[state.postOk ? "refusedLate" : "rejected"] ??= rejectionOf(body.subarray(0, 64 * 1024).toString("utf8"));
        if (known) state.postOk ??= finalUrl;
      }
      if (enquiry && res.status >= 400) state.carrierFailed ??= `${res.status} ${finalUrl}`;
      if (main && res.status >= 300 && res.status <= 399) {
        const location = res.headers.get("location");
        const next = location ? new URL(location, finalUrl) : null;
        if (next && (!httpish(next) || !portOk(next, opts.allowPorts))) state.blocked = `redirect to ${next.protocol}//${next.host} is not allowed`;
        else if (next && !afterClick) state.redirect = next.href;
        // After the click a redirect is never followed or recorded: the page it names was not loaded.
        return await route.fulfill({ status: 204, body: "" });
      }
      if (main && afterClick && res.status >= 200 && res.status < 300 && !samePage(finalUrl, state.formUrl)) state.navigatedTo ??= finalUrl;
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
