import "server-only";

import type { BrowserContext, Page, Request, Route } from "playwright-core";
import { publicFetch, type PublicFetchInit } from "@/lib/webhooks/public-fetch";
import { NonPublicUrlError } from "@/lib/webhooks/validate-url";
import { sameSite } from "@/lib/prospecting/registrable-domain";
import { CAPTCHA_URL } from "./page-scan";

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
 */

export type FetchImpl = (url: string, init: PublicFetchInit) => Promise<Response>;

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Initial document + one redirect, before the submit. */
export const MAX_MAIN_DOCUMENTS = 2;
const SUBRESOURCE_REDIRECTS = 3;

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
  /** After the click: a 2xx to a POST, same site or a known backend. */
  postOk: string | null;
  /** After the click: a main-frame navigation answered (2xx/3xx) at a URL other than `formUrl`. */
  navigatedTo: string | null;
  /** The form page's URL once loaded (engine.ts). */
  formUrl: string | null;
}

export function newGuardState(): GuardState {
  return {
    blocked: null, fetchError: null, mainDocuments: 0, tooManyRedirects: false, redirect: null, captcha: null,
    clickedAt: null, postsOut: 0, postOk: null, navigatedTo: null, formUrl: null,
  };
}

const httpish = (u: URL) => u.protocol === "http:" || u.protocol === "https:";

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
  opts: { fetchImpl: FetchImpl; signal: AbortSignal; state: GuardState },
  hops: number,
): Promise<{ res: Response; url: string }> {
  const { fetchImpl, signal, state } = opts;
  let url = req.url();
  let method = req.method();
  let body: Buffer | undefined = req.postDataBuffer() ?? undefined;
  const headers = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([k]) => !DROP_REQUEST.has(k)));
  for (let i = 0; ; i++) {
    const posting = method === "POST" && state.clickedAt !== null;
    let res: Response;
    try {
      res = await fetchImpl(url, { method, headers, body, signal, maxBytes: MAX_BODY_BYTES });
    } catch (err) {
      // A refused address was never connected to; any other error may have delivered the POST.
      if (posting && !(err instanceof NonPublicUrlError)) state.postsOut++;
      throw err;
    }
    if (posting) state.postsOut++;
    const location = res.headers.get("location");
    if (res.status < 300 || res.status > 399 || !location || i >= hops) return { res, url };
    const next = new URL(location, url);
    if (!httpish(next)) throw new NonPublicUrlError(next.protocol);
    if (res.status <= 303 && method !== "GET" && method !== "HEAD") {
      method = "GET";
      body = undefined;
    }
    url = next.href;
  }
}

async function fulfill(route: Route, res: Response) {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (!DROP_RESPONSE.has(k)) headers[k] = v;
  });
  // Playwright splits a newline-joined Set-Cookie back into one header per cookie.
  const cookies = res.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies.join("\n");
  await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
}

/** Route every request of `context` through `fetchImpl`; `state` records what engine.ts needs to know. */
export async function installNetworkGuard(
  context: BrowserContext,
  page: Page,
  opts: { fetchImpl: FetchImpl; signal: AbortSignal; state: GuardState },
): Promise<void> {
  const { signal, state } = opts;
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
    try {
      const { res, url: finalUrl } = await fetchHops(req, opts, main ? 0 : SUBRESOURCE_REDIRECTS);
      if (main && res.headers.get("cf-mitigated")) state.captcha ??= "Cloudflare challenge response";
      const host = new URL(finalUrl).hostname;
      const known = state.formUrl !== null && (sameSite(host, new URL(state.formUrl).hostname) || FORM_BACKENDS.test(host));
      if (afterClick && req.method() === "POST" && res.status >= 200 && res.status < 300 && known) state.postOk ??= finalUrl;
      if (main && res.status >= 300 && res.status <= 399) {
        const location = res.headers.get("location");
        const next = location ? new URL(location, finalUrl) : null;
        if (next && !httpish(next)) state.blocked = `redirect to ${next.protocol} is not allowed`;
        else if (next) state.redirect = next.href;
        if (afterClick && next && next.href !== state.formUrl) state.navigatedTo ??= next.href;
        return route.fulfill({ status: 204, body: "" });
      }
      if (main && afterClick && res.status < 400 && finalUrl !== state.formUrl) state.navigatedTo ??= finalUrl;
      return await fulfill(route, res);
    } catch (err) {
      const refused = err instanceof NonPublicUrlError;
      if (main && refused) state.blocked = err.message;
      else if (main) state.fetchError ??= err instanceof Error ? err.message : String(err);
      return route.abort(refused ? "blockedbyclient" : signal.aborted ? "timedout" : "failed").catch((e: unknown) => {
        // The page may already be closed (timeout): nothing left to answer.
        if (!signal.aborted) console.error("[mystery-shop/form] route abort failed", e);
      });
    }
  });
}

export const defaultFetch: FetchImpl = (url, init) => publicFetch(url, init);
