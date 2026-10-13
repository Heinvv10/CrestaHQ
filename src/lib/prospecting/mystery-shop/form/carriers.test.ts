import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY, SIMPLE_FIELDS, form, html, loopbackFetch, otherSite, ports, serve, skipBrowser, type Fixture, type Handler,
} from "@/test/form-fixture-server";
import { runFormFill, type FormRunInput } from "./engine";

/**
 * The requests carrying the message, against fixture sites in the real
 * headless Chromium (PR 404 breaker round): one that ends any way but a 2xx
 * keeps every other answer from confirming the enquiry — and so does one
 * still unanswered; a refusal is held until the message goes quiet and is
 * never `rejected` while it went out more than once; and a textarea that
 * hard-wraps the message as it submits still counts as carrying it.
 */

let site: Fixture;
async function run(routes: Record<string, Handler>, limits: FormRunInput["limits"] = {}) {
  site = await serve(routes);
  return runFormFill({
    url: `${site.origin}/contact`, identity: IDENTITY, fetchImpl: loopbackFetch(site.origin, otherSite(site.origin)),
    allowPorts: ports(site.origin), limits: { settleMs: 100, confirmMs: 4_000, ...limits },
  });
}
const ok: Handler = (_q, res) => html(res, "{}", 200);
const script = (js: string) => `<script>document.querySelector("form").addEventListener("submit", (e) => { ${js} });</script>`;
/** The message to /api/log, then — once that was answered — to /api/enquiry. */
const LOG_THEN_ENQUIRY = `e.preventDefault(); const body = new URLSearchParams(new FormData(e.target));
  fetch("/api/log", { method: "POST", body }).then(() => fetch("/api/enquiry", { method: "POST", body }));`;
/** A copy of the message to /api/log as the native POST goes out (kept alive across the navigation). */
const KEEPALIVE_LOG = `fetch("/api/log", { method: "POST", body: new URLSearchParams(new FormData(e.target)), keepalive: true });`;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await site?.close();
});

describe.skipIf(skipBrowser)("a request carrying the message that ends any way but a 2xx", () => {
  it("message 2xx at /api/log, the enquiry's connection dropped: uncertain, not sent", async () => {
    const out = await run({
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + script(`e.preventDefault();
        const body = new URLSearchParams(new FormData(e.target));
        fetch("/api/log", { method: "POST", body }).then(() => fetch("/api/enquiry", { method: "POST", body }));`)),
      "/api/log": ok, "/api/enquiry": (_q, res) => void res.destroy(),
    });
    expect(site.posts.map((p) => p.path)).toEqual(["/api/log", "/api/enquiry"]);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("the native POST bounced back to the form (302 /contact?error=1), a keepalive log 2xx: uncertain, not sent", async () => {
    const out = await run({
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + script(KEEPALIVE_LOG)),
      "/api/log": ok, "/send": (_q, res) => html(res, "", 302, { location: "/contact?error=1" }),
    });
    expect(site.posts.map((p) => p.path).sort()).toEqual(["/api/log", "/send"]);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("the native POST answered by a 303 to the homepage (the 3xx is the answer), a keepalive log 2xx: uncertain", async () => {
    const out = await run({
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + script(KEEPALIVE_LOG)),
      "/api/log": ok, "/send": (_q, res) => html(res, "", 303, { location: "/" }),
    });
    expect(site.posts.map((p) => p.path).sort()).toEqual(["/api/log", "/send"]);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("the enquiry goes by sendBeacon (aborted here, never leaves), /api/log 2xx: uncertain, not sent", async () => {
    const out = await run({
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + script(`e.preventDefault();
        const body = new URLSearchParams(new FormData(e.target));
        fetch("/api/log", { method: "POST", body }).then(() => navigator.sendBeacon("/api/enquiry", body));`)),
      "/api/log": ok, "/api/enquiry": ok,
    });
    expect(site.posts.map((p) => p.path)).toEqual(["/api/log"]);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });
});

describe.skipIf(skipBrowser)("a request carrying the message still unanswered", () => {
  it("/api/log 2xx, the enquiry still in flight when a bare 2xx would count (500 after 3 s): uncertain, not sent", async () => {
    const out = await run({
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + script(LOG_THEN_ENQUIRY)),
      "/api/log": ok, "/api/enquiry": (_q, res) => void setTimeout(() => html(res, "", 500), 3_000),
    });
    expect(site.posts.map((p) => p.path)).toEqual(["/api/log", "/api/enquiry"]);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("/api/log 2xx, the enquiry never answered inside the window: uncertain, not sent", async () => {
    const out = await run({
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + script(LOG_THEN_ENQUIRY)),
      "/api/log": ok, "/api/enquiry": () => undefined,
    });
    expect(site.posts.map((p) => p.path)).toEqual(["/api/log", "/api/enquiry"]);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("one fetch of the enquiry, the page navigates to /thanks before its 2xx lands: sent once it lands", async () => {
    const out = await run({
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + script(`e.preventDefault();
        fetch("/api/enquiry", { method: "POST", body: new URLSearchParams(new FormData(e.target)) });
        setTimeout(() => { location.href = "/thanks"; }, 50);`)),
      "/api/enquiry": (_q, res) => void setTimeout(() => html(res, "{}", 200), 400),
      "/thanks": (_q, res) => html(res, "<h1>Thank you for your message</h1>"),
    });
    expect(site.posts.map((p) => p.path)).toEqual(["/api/enquiry"]);
    expect(out).toMatchObject({ kind: "sent" });
  });
});

describe.skipIf(skipBrowser)("a refusal while the message went out more than once", () => {
  it("a copy refused (success:false), the enquiry 400 ms after that answer: uncertain, never rejected", async () => {
    const json = { "content-type": "application/json" };
    const out = await run({
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + script(`e.preventDefault(); const body = new URLSearchParams(new FormData(e.target));
        fetch("/api/subscribe", { method: "POST", body }).then(() => new Promise((r) => setTimeout(r, 400)))
          .then(() => fetch("/api/enquiry", { method: "POST", body }));`)),
      "/api/subscribe": (_q, res) => html(res, '{"success":false}', 200, json), "/api/enquiry": ok,
    });
    expect(site.posts.map((p) => p.path)).toEqual(["/api/subscribe", "/api/enquiry"]);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("a same-site copy says success:false before the enquiry's 2xx lands: uncertain, never rejected", async () => {
    const json = { "content-type": "application/json" };
    const out = await run({
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + script(`e.preventDefault();
        const body = new URLSearchParams(new FormData(e.target));
        fetch("/api/subscribe", { method: "POST", body }); fetch("/api/enquiry", { method: "POST", body });`)),
      // The enquiry arrives at once; its answer is slower than the copy's refusal.
      "/api/subscribe": (_q, res) => void setTimeout(() => html(res, '{"success":false}', 200, json), 100),
      "/api/enquiry": (_q, res) => void setTimeout(() => html(res, "{}", 200), 600),
    });
    expect(site.posts.map((p) => p.path).sort()).toEqual(["/api/enquiry", "/api/subscribe"]);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });
});

describe.skipIf(skipBrowser)("a message the browser hard-wraps as it submits", () => {
  it('a textarea with wrap="hard", one native POST answered by a thank-you page: sent', async () => {
    const fields = SIMPLE_FIELDS.replace("<textarea ", '<textarea wrap="hard" cols="20" ');
    const out = await run({
      "/contact": (_q, res) => html(res, form(fields)),
      "/send": (_q, res) => html(res, "<h1>Thank you for your message</h1>"),
    });
    expect(site.posts.map((p) => p.path)).toEqual(["/send"]);
    expect(site.posts[0].body).toContain("%0D%0A");
    expect(out).toMatchObject({ kind: "sent" });
  });

  it('a textarea with wrap="hard" cols=5 (breaks inside words), one native POST answered by a thank-you page: sent', async () => {
    const fields = SIMPLE_FIELDS.replace("<textarea ", '<textarea wrap="hard" cols="5" ');
    const out = await run({
      "/contact": (_q, res) => html(res, form(fields)),
      "/send": (_q, res) => html(res, "<h1>Thank you for your message</h1>"),
    });
    expect(site.posts.map((p) => p.path)).toEqual(["/send"]);
    expect(site.posts[0].body).toMatch(/[a-z]%0D%0A[a-z]/i);
    expect(out).toMatchObject({ kind: "sent" });
  });
});
