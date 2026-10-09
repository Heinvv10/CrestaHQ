import http from "node:http";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { publicFetch } from "@/lib/webhooks/public-fetch";
import { ssrfGuardEnabled } from "@/lib/webhooks/validate-url";
import type { FetchImpl } from "@/lib/prospecting/mystery-shop/form/network";
import { launchFormBrowser, type FormBrowser } from "@/lib/prospecting/mystery-shop/form/browser";
import type { FormIdentity } from "@/lib/prospecting/mystery-shop/form/mapping";

/**
 * Fixture websites for the form-engine tests, served on 127.0.0.1 by the test
 * itself — never a real site. The SSRF guard refuses loopback, so the engine
 * is given `loopbackFetch(origin)`: a plain fetch (redirects NOT followed) for
 * that fixture origin (and any extra ones), the real publicFetch for an IP literal — which its
 * guard refuses before connecting (the tests stub NODE_ENV=production, and
 * this refuses to run without it) — and nothing at all for a host name: a
 * test (or a mutation of the guard) can never reach a real site or resolve a
 * real name.
 *
 * Chromium comes from playwright-core's cache (CI installs it before the
 * tests). Without it the browser tests skip locally and fail in CI.
 */

export const chromiumInstalled = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();
export const skipBrowser = !chromiumInstalled && !process.env.CI;

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

export interface Fixture {
  origin: string;
  /** Every request, as "METHOD /path". */
  hits: string[];
  /** POST bodies by path. */
  posts: { path: string; body: string }[];
  close: () => Promise<void>;
}

export const html = (res: http.ServerResponse, body: string, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(body);
};

/** `host` 0.0.0.0: reachable from a container through the docker bridge (the docker-gated test). */
export async function serve(routes: Record<string, Handler>, host = "127.0.0.1"): Promise<Fixture> {
  const hits: string[] = [];
  const posts: { path: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0];
      hits.push(`${req.method} ${req.url}`);
      if (req.method === "POST") posts.push({ path, body });
      const handler = routes[path];
      if (handler) handler(req, res, body);
      else html(res, "<p>not found</p>", 404);
    });
  });
  // An upgrade (WebSocket) attempt is a hit too.
  server.on("upgrade", (req, socket) => {
    hits.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    posts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The fixture origin unguarded (no redirects followed); everything else through the real publicFetch. */
export function loopbackFetch(origin: string, ...more: string[]): FetchImpl {
  const allowed = new Set([origin, ...more]);
  return async (url, init) => {
    const u = new URL(url);
    if (allowed.has(u.origin)) {
      const body = typeof init.body === "string" || init.body === undefined ? init.body : Buffer.from(init.body);
      return fetch(url, { method: init.method, headers: init.headers, body, signal: init.signal, redirect: "manual" });
    }
    if (!ssrfGuardEnabled()) throw new Error("form fixture: stub NODE_ENV=production so publicFetch is guarded");
    if (!/^(\[.*\]|[0-9.]+)$/.test(u.hostname)) throw new Error(`form fixture: no request to ${u.hostname}`);
    return publicFetch(url, init);
  };
}

/** The fixtures' explicit ports, for `allowPorts` (production allows only 80 / 443). */
export const ports = (...origins: string[]) => origins.map((o) => new URL(o).port);

/** The same fixture under another host name: a different site to the engine (sameSite compares hosts). */
export const otherSite = (origin: string) => origin.replace("127.0.0.1", "localhost");

/** The fields a person types into (not hidden, checkbox, radio or button inputs, whose value is fixed). */
const TYPED = `textarea, input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=url], input[type=number], input[type=search]`;

/** launchFormBrowser, plus a snapshot of every typed field's value taken as the engine closes the browser. */
export function capturingLaunch(): { launch: () => Promise<FormBrowser>; values: () => string[] | null } {
  let values: string[] | null = null;
  return {
    values: () => values,
    launch: async () => {
      const browser = await launchFormBrowser();
      return {
        context: browser.context,
        close: async () => {
          if (values === null) {
            values = [];
            for (const page of browser.context.pages()) {
              const v = (await page
                .evaluate(`[...document.querySelectorAll(${JSON.stringify(TYPED)})].map((e) => e.value)`)
                .catch(() => [])) as string[];
              values.push(...v);
            }
          }
          return browser.close();
        },
      };
    },
  };
}

export const IDENTITY: FormIdentity = {
  business: "Cresta HQ",
  email: "info@crestahq.com",
  phone: "+27784356159",
  subject: "Enquiry: plumber in Gqeberha",
  message: "Hi,\n\nDo you do plumber in Gqeberha? What's your earliest availability?\n\nThanks,\nCresta HQ",
  service: "plumber",
};

export const form = (inner: string, attrs = 'method="post" action="/send"') => `<!doctype html><html><head><title>Contact</title></head>
<body><h1>Contact us</h1><form ${attrs}>${inner}</form></body></html>`;

/** A plain contact form: name, email, phone, message, submit. */
export const SIMPLE_FIELDS = `<label for="n">Your name</label><input id="n" name="your-name" required>
<label>Email <input type="email" name="email" required></label>
<input type="tel" name="phone" placeholder="Phone">
<textarea name="message" placeholder="How can we help?" required></textarea>
<button type="submit">Send</button>`;
