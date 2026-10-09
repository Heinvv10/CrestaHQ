import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY, SIMPLE_FIELDS, form, html, loopbackFetch, otherSite, ports, serve, skipBrowser, type Fixture, type Handler,
} from "@/test/form-fixture-server";
import { LAUNCH_ARGS, launchFormBrowser } from "./browser";
import { runFormFill, type FormRunInput } from "./engine";

/**
 * Quality review (Q1, Q2, Q4): what is NOT a confirmation, the crash and
 * refused-submit branches after the click, and schemes that must fail on
 * their own — without the dead proxy behind them.
 */

let site: Fixture;
let internal: Fixture;
beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.spyOn(console, "error").mockImplementation(() => {});
  internal = await serve({ "/": (_q, res) => html(res, "internal") });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await site?.close();
  await internal.close();
});

const page = (body: string): Handler => (_q, res) => html(res, body);
const noProxy = () => launchFormBrowser(LAUNCH_ARGS.filter((a) => !a.includes("proxy")));
async function run(routes: Record<string, Handler>, over: Partial<FormRunInput> = {}, path = "/contact") {
  site = await serve(routes);
  return runFormFill({
    // The fixture also answers as `localhost`: another site to the engine.
    url: `${site.origin}${path}`, identity: IDENTITY, fetchImpl: loopbackFetch(site.origin, otherSite(site.origin)),
    allowPorts: ports(site.origin, internal.origin), limits: { totalMs: 15_000, settleMs: 200, confirmMs: 2_000 }, ...over,
  });
}
const T = 60_000;

describe.skipIf(skipBrowser)("Q1: never 'sent' without an accepted enquiry", () => {
  it.each([
    ["the form POST answered 500 with thank-you text", "<h1>Thank you</h1>", 500],
    ["the form POST answered 400 with thank-you text", "<h1>Thanks, we'll be in touch</h1>", 400],
  ])("%s", async (_name, body, status) => {
    const out = await run({ "/contact": page(form(SIMPLE_FIELDS)), "/send": (_q, res) => html(res, body, status) });
    expect(out.kind).not.toBe("sent");
  }, T);

  it("a 303 back to the form page (/contact?error=1) is not a confirmation", async () => {
    const out = await run({
      "/contact": page(form(SIMPLE_FIELDS)),
      "/send": (_q, res) => html(res, "", 303, { location: "/contact?error=1" }),
    });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  }, T);

  it("pushState('/thanks') plus thank-you text with no enquiry request is not a confirmation", async () => {
    const js = `history.pushState(null, "", "/thanks"); document.body.insertAdjacentHTML("beforeend", "<h1>Thank you!</h1>");`;
    const out = await run({
      "/contact": page(form(SIMPLE_FIELDS).replace("</form>", `</form><script>document.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); ${js} });</script>`)),
    });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  }, T);
});

describe.skipIf(skipBrowser)("Z1: a 3xx answer to the enquiry is never a confirmation by itself", () => {
  const thanks = page("<h1>Thank you for your message</h1>");
  const posted = (path: string) => site.posts.filter((p) => p.path === path).map((p) => new URLSearchParams(p.body).get("email"));

  it("a 308 is re-posted (same body) for one hop, and that hop's answer decides", async () => {
    const out = await run({ "/contact": page(form(SIMPLE_FIELDS)), "/send": (_q, res) => html(res, "", 308, { location: "/send2" }), "/send2": thanks });
    expect(posted("/send2")).toEqual([IDENTITY.email]);
    expect(out).toMatchObject({ kind: "sent", trace: { finalUrl: `${site.origin}/send2` } });
  }, T);

  it("only ONE hop: a 308 whose target answers another 308 is uncertain", async () => {
    const out = await run({
      "/contact": page(form(SIMPLE_FIELDS)),
      "/send": (_q, res) => html(res, "", 308, { location: "/send2" }),
      "/send2": (_q, res) => html(res, "", 308, { location: "/send3" }),
      "/send3": thanks,
    });
    expect(site.posts.map((p) => p.path)).toEqual(["/send", "/send2"]);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  }, T);

  it("a 301 to the same path with a trailing slash is re-posted too", async () => {
    const out = await run({ "/contact": page(form(SIMPLE_FIELDS)), "/send": (_q, res) => html(res, "", 301, { location: "/send/" }), "/send/": thanks });
    expect(site.posts.map((p) => p.path)).toEqual(["/send", "/send/"]);
    expect(posted("/send/")).toEqual([IDENTITY.email]);
    expect(out.kind).toBe("sent");
  }, T);

  it("a 307 to an internal address: re-posted only through the guard — refused, never sent", async () => {
    const out = await run({ "/contact": page(form(SIMPLE_FIELDS)), "/send": (_q, res) => html(res, "", 307, { location: `${internal.origin}/` }) });
    expect(internal.hits).toEqual([]);
    expect(out.kind).not.toBe("sent");
  }, T);

  it("a 302 to https on the same path: the hop fails here, so not sent, and the unloaded https page is never the trace", async () => {
    const out = await run({ "/contact": page(form(SIMPLE_FIELDS)), "/send": (_q, res) => html(res, "", 302, { location: `${site.origin.replace("http:", "https:")}/send` }) });
    expect(out.kind).not.toBe("sent");
    expect(out.trace.finalUrl ?? "").not.toMatch(/^https:/);
  }, T);

  // Post-redirect-get: a 302/303 to ANOTHER path is followed with exactly one GET; only a 2xx HTML page that
  // is not the form page and shows thank-you text confirms — so a spam bounce to the homepage never counts.
  const prg = (to: string, routes: Record<string, Handler>) =>
    run({ "/contact": page(form(SIMPLE_FIELDS)), "/send": (_q, res) => html(res, "", 303, { location: to }), ...routes });

  it("a 303 to a thank-you page that says thank you: sent, and that loaded page is the trace", async () => {
    const out = await prg("/thank-you", { "/thank-you": thanks });
    expect(out).toMatchObject({ kind: "sent", trace: { signal: "navigation", finalUrl: `${site.origin}/thank-you` } });
    expect(site.hits.filter((h) => h === "GET /thank-you")).toHaveLength(1);
  }, T);

  it("a 303 to the same path with another query (/send?ok=1) is not a post-redirect-get: uncertain", async () => {
    const out = await run({
      "/contact": page(form(SIMPLE_FIELDS)),
      "/send": (q, res) => (q.method === "POST" ? html(res, "", 303, { location: "/send?ok=1" }) : html(res, "<h1>Thank you</h1>")),
    });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
    expect(site.hits).not.toContain("GET /send?ok=1");
  }, T);

  it("the form page's own thanks never count, even while the new page never replaces it (a download)", async () => {
    const out = await run({
      "/contact": page(form(SIMPLE_FIELDS) + "<footer>Thanks for visiting</footer>"),
      "/send": (_q, res) => html(res, "", 303, { location: "/thank-you" }),
      "/thank-you": (_q, res) => html(res, "<h1>Thank you</h1>", 200, { "content-disposition": "attachment; filename=thanks.html" }),
    });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  }, T);

  it.each([
    ["the homepage, thanking its customers", "/", "<h1>Thanks to 500 happy customers</h1><p>Award received 2024</p>"],
    ["a page that thanks loosely (no enquiry phrase)", "/news", "<h1>Thanks to 500 happy customers</h1><p>Award received 2024</p>"],
    ["an error page that thanks you for your patience", "/contact-error", "<h1>Sorry, something went wrong</h1><p>Thank you for your message — please try again. Thank you for your patience.</p>"],
    ["the homepage even with the exact phrase", "/", "<h1>Thank you for your message</h1>"],
  ])("a post-redirect-get to %s: uncertain", async (_name, to, body) => {
    const out = await prg(to, { [to]: page(body) });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  }, T);

  it("a post-redirect-get to another site, however thankful: uncertain, and never fetched", async () => {
    const out = await run({
      "/contact": page(form(SIMPLE_FIELDS)),
      "/send": (q, res) => html(res, "", 303, { location: `http://localhost:${q.socket.localPort}/thank-you` }),
      "/thank-you": thanks,
    });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
    expect(site.hits).not.toContain("GET /thank-you");
  }, T);

  it("a 301 to another path is not a post-redirect-get: uncertain, not fetched", async () => {
    const out = await run({ "/contact": page(form(SIMPLE_FIELDS)), "/send": (_q, res) => html(res, "", 301, { location: "/thank-you" }), "/thank-you": thanks });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
    expect(site.hits).not.toContain("GET /thank-you");
  }, T);

  it("a 303 is never re-POSTed (not even to the same path with a slash)", async () => {
    const out = await run({ "/contact": page(form(SIMPLE_FIELDS)), "/send": (_q, res) => html(res, "", 303, { location: "/send/" }), "/send/": thanks });
    expect(site.posts.map((p) => p.path)).toEqual(["/send"]);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  }, T);

  it("post-redirect-get counts only for the page itself, not an XHR followed to a thank-you", async () => {
    const js = `fetch("/api/send", { method: "POST", body: new FormData(e.target) }).then(() => { location.href = "/thank-you"; });`;
    const out = await run({
      "/contact": page(form(SIMPLE_FIELDS).replace("</form>", `</form><script>document.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); ${js} });</script>`)),
      "/api/send": (_q, res) => html(res, "", 303, { location: "/thank-you" }),
      "/thank-you": thanks,
    });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  }, T);

  it("a thank-you page carrying a CAPTCHA: uncertain captcha_after_submit", async () => {
    const out = await prg("/thank-you", { "/thank-you": page(`<h1>Thank you for your message</h1><div class="g-recaptcha" data-sitekey="x"></div>`) });
    expect(out).toMatchObject({ kind: "uncertain", code: "captcha_after_submit" });
  }, T);

  it("a 3xx after the click is never recorded as where the page went", async () => {
    const js = `fetch(location.origin.replace("127.0.0.1", "localhost") + "/collect", { method: "POST", body: new FormData(e.target) }).then(() => { location.href = "/go"; });`;
    const out = await run({
      "/contact": page(form(SIMPLE_FIELDS).replace("</form>", `</form><script>document.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); ${js} });</script>`)),
      "/collect": page("ok"),
      "/go": (_q, res) => html(res, "", 302, { location: "/elsewhere" }),
      "/elsewhere": page("<p>somewhere</p>"),
    });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
    expect(out.trace.finalUrl ?? "").not.toMatch(/elsewhere/);
  }, T);

  it("the form page's own confirmation wording never counts while a post-redirect-get page never replaces it", async () => {
    const out = await run({
      "/contact": page(form(SIMPLE_FIELDS) + "<p>Thank you for contacting us — we reply within a day.</p>"),
      "/send": (_q, res) => html(res, "", 303, { location: "/contact-error" }),
      "/contact-error": (_q, res) => html(res, "<h1>Something went wrong</h1>", 200, { "content-disposition": "attachment; filename=error.html" }),
    });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  }, T);

  it("a 303 to the homepage with no thank-you text (a spam bounce): uncertain", async () => {
    const out = await prg("/", { "/": page("<h1>Acme Plumbing</h1><p>Plumbers in Gqeberha since 1999.</p>") });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  }, T);

  it("a 303 back to the form page with a query (/contact?sent=0), even saying thanks: uncertain", async () => {
    const out = await run({
      "/contact": (q, res) => html(res, q.url?.includes("sent=0") ? "<h1>Thanks — but please try again</h1>" : form(SIMPLE_FIELDS)),
      "/send": (_q, res) => html(res, "", 303, { location: "/contact?sent=0" }),
    });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  }, T);

  it("a 302 to /thanks that answers 500 with thank-you text: uncertain", async () => {
    const out = await run({
      "/contact": page(form(SIMPLE_FIELDS)),
      "/send": (_q, res) => html(res, "", 302, { location: "/thanks" }),
      "/thanks": (_q, res) => html(res, "<h1>Thank you</h1>", 500),
    });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  }, T);

  it("a second redirect after the GET: uncertain, never followed", async () => {
    const out = await prg("/thank-you", { "/thank-you": (_q, res) => html(res, "", 302, { location: "/really-thanks" }), "/really-thanks": thanks });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
    expect(site.hits).not.toContain("GET /really-thanks");
  }, T);

  it("a thank-you page that isn't HTML (JSON saying thanks): uncertain", async () => {
    const out = await prg("/thank-you", { "/thank-you": (_q, res) => (res.writeHead(200, { "content-type": "application/json" }), res.end('{"message":"Thank you"}')) });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  }, T);

  it("a thank-you page whose thanks are hidden (not visible text): uncertain", async () => {
    const out = await prg("/thank-you", { "/thank-you": page(`<h1>Acme</h1><p style="display:none">Thank you</p>`) });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  }, T);

  it("a 303 to an internal address is never followed", async () => {
    const out = await prg(`${internal.origin}/thanks`, {});
    expect(internal.hits).toEqual([]);
    expect(out.kind).not.toBe("sent");
  }, T);
});

describe.skipIf(skipBrowser)("Q2: after the click", () => {
  it("a crash after the click is uncertain (it may have gone through), never failed", async () => {
    const out = await run(
      { "/contact": page(form(SIMPLE_FIELDS)), "/send": () => undefined },
      {
        launch: async () => {
          const b = await launchFormBrowser();
          // The browser dies the moment the form is posted.
          b.context.on("request", (req) => void (req.method() === "POST" && b.context.close().catch(() => undefined)));
          return b;
        },
      },
    );
    expect(out).toMatchObject({ kind: "uncertain" });
  }, T);

  it("a submit to a refused address AFTER the enquiry already went out is not a refusal", async () => {
    const i = internal.origin;
    const js = `fetch("/api/enquiry", { method: "POST", body: new FormData(e.target) }).then(() => { location.href = "${i}/"; });`;
    const out = await run({
      "/contact": page(form(SIMPLE_FIELDS).replace("</form>", `</form><script>document.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); ${js} });</script>`)),
      "/api/enquiry": page("ok"),
    });
    expect(out.kind).not.toBe("refused");
    expect(internal.hits).toEqual([]);
  }, T);
});

describe.skipIf(skipBrowser)("Q4: schemes refuse on their own (no dead proxy behind them)", () => {
  it.each(["file:///etc/passwd", "data:text/html,<form><input name=a><textarea name=m></textarea><button>x</button></form>", "javascript:alert(1)", "ftp://203.0.113.9/"])(
    "the form URL %s is refused before anything loads",
    async (url) => {
      const out = await runFormFill({ url, identity: IDENTITY, launch: noProxy, limits: { totalMs: 10_000, settleMs: 200, confirmMs: 1_000 } });
      expect(out).toMatchObject({ kind: "refused", code: "ssrf_blocked" });
    },
    T,
  );

  it.each([
    ["a script navigation to file:", `location.href = "file:///etc/passwd";`],
    ["a script navigation to data:", `location.href = "data:text/html,<p>x</p>";`],
    ["a script navigation to javascript:", `location.href = "javascript:void(0)";`],
    ["a script navigation to the internal host", `location.href = "INTERNAL/";`],
  ])("%s never leaves the page's control", async (_name, js) => {
    const out = await run(
      { "/contact": page(form(SIMPLE_FIELDS) + `<script>setTimeout(() => { ${js.replace("INTERNAL", internal.origin)} }, 50);</script>`) },
      { launch: noProxy },
    );
    expect(internal.hits).toEqual([]);
    expect(out.trace.finalUrl ?? "").not.toMatch(/^(file|data|javascript):/);
  }, T);
});
