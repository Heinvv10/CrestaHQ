import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY, SIMPLE_FIELDS, capturingLaunch, form, html, loopbackFetch, otherSite, ports, serve, skipBrowser, type Fixture, type Handler,
} from "@/test/form-fixture-server";
import { runFormFill, traceUrl, type FormRunInput } from "./engine";

/**
 * The form engine against fixture sites on 127.0.0.1, driving the real
 * headless Chromium: field mapping on four forms, every confirmation signal,
 * the refusals, and the time limit. CAPTCHA and SSRF: captcha.test.ts and
 * ssrf.test.ts.
 */

let site: Fixture;
const thanks: Handler = (_q, res) => html(res, "<h1>Thank you for your message</h1>");
const redirectTo = (to: string): Handler => (_q, res) => html(res, "", 303, { location: to });

async function run(routes: Record<string, Handler>, path = "/contact", over: Partial<FormRunInput> = {}) {
  site = await serve(routes);
  return runFormFill({
    // The fixture also answers as `localhost`: another site to the engine.
    url: `${site.origin}${path}`, identity: IDENTITY, fetchImpl: loopbackFetch(site.origin, otherSite(site.origin)),
    allowPorts: ports(site.origin),
    limits: { settleMs: 100, confirmMs: 4_000 }, ...over,
  });
}
/** A textarea's line breaks are submitted as CRLF (HTML form encoding). */
const MESSAGE = IDENTITY.message.replaceAll("\n", "\r\n");
const posted = (path = "/send") => new URLSearchParams(site.posts.find((p) => p.path === path)?.body ?? "");

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await site?.close();
});

describe("traceUrl (what the member-only trace keeps)", () => {
  it("http(s) only, without the query (which may carry what was typed) or the fragment", () => {
    expect(traceUrl("https://www.acme.co.za/thanks?email=info%40crestahq.com#top")).toBe("https://www.acme.co.za/thanks");
    expect(traceUrl("javascript:alert(1)")).toBeNull();
    expect(traceUrl("chrome-error://chromewebdata/")).toBeNull();
    expect(traceUrl(null)).toBeNull();
    expect(traceUrl("not a url")).toBeNull();
  });
});

describe.skipIf(skipBrowser)("field mapping on four fixture forms", () => {
  it("a simple form: name, email, phone, message — after one redirect — confirmed by the page its POST returned", async () => {
    const out = await run({
      "/": redirectTo("/contact"),
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS)),
      "/send": thanks,
    }, "/");
    expect(out).toMatchObject({ kind: "sent", trace: { signal: "navigation", mappedFields: ["name", "email", "phone", "message"] } });
    expect(out.trace.finalUrl).toBe(`${site.origin}/send`);
    expect(Object.fromEntries(posted())).toEqual({
      "your-name": "Cresta HQ", email: "info@crestahq.com", phone: "+27784356159", message: MESSAGE,
    });
  });

  it("first + last name and a service select (the matching option is chosen)", async () => {
    const fields = `<input name="first_name" placeholder="First name" required><input name="last_name" placeholder="Last name" required>
      <input type="email" name="mail" required>
      <select name="service" required><option value="">Choose a service</option><option value="elec">Electrical</option>
      <option value="plumb">Plumber call-out</option></select>
      <select name="country"><option value="za">South Africa</option><option value="pl">plumber</option></select>
      <textarea name="details"></textarea><input type="submit" value="Send">`;
    const out = await run({ "/contact": (_q, res) => html(res, form(fields)), "/send": thanks });
    expect(out).toMatchObject({ kind: "sent", trace: { mappedFields: ["first", "last", "email", "service", "message"] } });
    expect(Object.fromEntries(posted())).toEqual({
      first_name: "Cresta", last_name: "HQ", mail: "info@crestahq.com", service: "plumb", country: "za", details: MESSAGE,
    });
  });

  it("a WordPress CF7-like form: the honeypot and the hidden fields are never filled", async () => {
    const fields = `<div style="display:none"><input type="hidden" name="_wpcf7" value="42"><input type="hidden" name="_wpcf7_unit_tag" value="wpcf7-f42"></div>
      <p><label>Your name<br><span class="wpcf7-form-control-wrap"><input type="text" name="your-name" aria-required="true"></span></label></p>
      <p><label>Your email<br><input type="email" name="your-email" aria-required="true"></label></p>
      <p><label>Subject<br><input type="text" name="your-subject"></label></p>
      <p><label>Your message<br><textarea name="your-message"></textarea></label></p>
      <span class="wpcf7-form-control-wrap" style="position:absolute;left:-9999px"><input type="text" name="website-hp" tabindex="-1" autocomplete="off"></span>
      <span style="display:none"><input type="text" name="your-name-confirm"></span>
      <input type="submit" value="Send" class="wpcf7-submit">`;
    const out = await run({
      "/contact": (_q, res) => html(res, form(fields, 'method="post" action="/send" class="wpcf7-form"')),
      "/send": (_q, res) => html(res, `<div class="wpcf7-response-output">Thank you for your message. It has been sent.</div>`),
    });
    expect(out).toMatchObject({ kind: "sent", trace: { mappedFields: ["name", "email", "subject", "message"] } });
    expect(Object.fromEntries(posted())).toEqual({
      _wpcf7: "42", _wpcf7_unit_tag: "wpcf7-f42", "your-name": "Cresta HQ", "your-email": "info@crestahq.com",
      "your-subject": IDENTITY.subject, "your-message": MESSAGE, "website-hp": "", "your-name-confirm": "",
    });
  });

  it("the crestahq.com audit form (plus a message box): the town goes in `where`, the honeypot and the opt-in stay empty", async () => {
    const fields = `<label for="p">Your name</label><input id="p" name="person" autocomplete="name" required>
      <label for="b">Business name</label><input id="b" name="business" placeholder="Example: Cape Town Plumbers" autocomplete="organization" required>
      <label for="w">Town or suburb</label><input id="w" name="where" placeholder="Example: Edenvale" autocomplete="address-level2" required>
      <label for="t">Mobile number (WhatsApp)</label><input id="t" name="phone" type="tel" autocomplete="tel" required>
      <label for="e">Email address (optional)</label><input id="e" name="email" type="email">
      <input type="text" name="website_url" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">
      <label><input name="marketingConsent" type="checkbox" value="yes"> Send me tips</label>
      <textarea name="message" placeholder="Anything else?"></textarea><button type="submit">Get my audit</button>`;
    const out = await run({ "/contact": (_q, res) => html(res, form(fields, 'id="auditForm" method="post" action="/send"')), "/send": thanks });
    expect(out).toMatchObject({ kind: "sent", trace: { mappedFields: ["name", "company", "town", "phone", "email", "message"] } });
    expect(Object.fromEntries(posted())).toEqual({
      person: "Cresta HQ", business: "Cresta HQ", where: "Gqeberha", phone: "+27784356159", email: "info@crestahq.com", website_url: "", message: MESSAGE,
    });
  });
});

/** A form whose submit is handled by `script`, on a page with an existing "Thanks" in the footer. */
const scripted = (script: string) =>
  form(SIMPLE_FIELDS) +
  `<footer>Thanks for visiting</footer><script>document.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); ${script} });</script>`;

describe.skipIf(skipBrowser)("confirmation", () => {
  it("new thank-you text on the same page, after the enquiry was posted", async () => {
    const out = await run({
      "/contact": (_q, res) =>
        html(res, scripted(`fetch("/api/enquiry", { method: "POST", body: new FormData(e.target) }).then(() => document.body.insertAdjacentHTML("beforeend", "<p>We'll be in touch soon.</p>"));`)),
      "/api/enquiry": (_q, res) => html(res, "<p>ok</p>", 200),
    });
    expect(out).toMatchObject({ kind: "sent", trace: { signal: "thank_you" } });
  });

  it("a 2xx to an XHR POST of the enquiry on the same site", async () => {
    const out = await run({
      "/contact": (_q, res) => html(res, scripted(`fetch("/api/enquiry", { method: "POST", body: new URLSearchParams(new FormData(e.target)) });`)),
      "/api/enquiry": (_q, res) => html(res, "{}", 200),
    });
    expect(out).toMatchObject({ kind: "sent", trace: { signal: "post_2xx" } });
  });

  it("thank-you text, a URL change or a 2xx without the enquiry ever being sent is never 'sent'", async () => {
    const out = await run({
      "/contact": (_q, res) =>
        html(res, scripted(`fetch("/api/ping", { method: "POST", body: "x=1" }); history.pushState(null, "", "/thanks"); document.body.insertAdjacentHTML("beforeend", "<p>Thank you!</p>");`)),
      "/api/ping": (_q, res) => html(res, "{}", 200),
    }, "/contact", { limits: { settleMs: 100, confirmMs: 1_500 } });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("an error page from the POST is not a confirmation, nor is text that was already there", async () => {
    const out = await run({
      "/contact": (_q, res) =>
        html(res, scripted(`fetch("/api/enquiry", { method: "POST", body: new FormData(e.target) }).then(() => document.body.insertAdjacentHTML("beforeend", "<p>Thank you!</p>"));`)),
      "/api/enquiry": (_q, res) => html(res, "{}", 500),
    }, "/contact", { limits: { settleMs: 100, confirmMs: 1_500 } });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("a 2xx POST to another site is not a confirmation", async () => {
    const out = await run({
      "/contact": (_q, res) =>
        html(res, scripted(`fetch(location.origin.replace("127.0.0.1", "localhost") + "/collect", { method: "POST", body: "x=1" }).catch(() => {});`)),
      "/collect": (_q, res) => html(res, "{}", 200),
    }, "/contact", { limits: { settleMs: 100, confirmMs: 1_500 } });
    expect(site.posts.map((p) => p.path)).toContain("/collect");
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("a 2xx POST from before the click (analytics while typing) is not a confirmation", async () => {
    const out = await run({
      "/contact": (_q, res) =>
        html(res, scripted("") + `<script>document.addEventListener("focusin", () => fetch("/api/track", { method: "POST", body: "x=1" }), { once: true });</script>`),
      "/api/track": (_q, res) => html(res, "{}", 200),
    }, "/contact", { limits: { settleMs: 300, confirmMs: 1_500 } });
    expect(site.posts.map((p) => p.path)).toEqual(["/api/track"]);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("a submit whose connection dropped shows Chromium's error page: uncertain, not a navigation", async () => {
    const out = await run({
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS)),
      "/send": (q) => q.socket.destroy(),
    }, "/contact", { limits: { settleMs: 100, confirmMs: 1_500 } });
    expect(site.posts.map((p) => p.path)).toEqual(["/send"]);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("a page that blanks itself after the submit has not navigated anywhere", async () => {
    const out = await run({ "/contact": (_q, res) => html(res, scripted(`location.href = "about:blank";`)) }, "/contact", {
      limits: { settleMs: 100, confirmMs: 1_500 },
    });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("the submit is stamped (onBeforeSubmit) before the form is posted; if that fails nothing is posted", async () => {
    const postsAtStamp: number[] = [];
    const routes = { "/contact": ((_q, res) => html(res, form(SIMPLE_FIELDS))) as Handler, "/send": thanks };
    const ok = await run(routes, "/contact", { onBeforeSubmit: async () => void postsAtStamp.push(site.posts.length) });
    expect(ok.kind).toBe("sent");
    expect(postsAtStamp).toEqual([0]);
    expect(site.posts).toHaveLength(1);
    await site.close();
    const failed = await run(routes, "/contact", { onBeforeSubmit: () => Promise.reject(new Error("firestore down")) });
    expect(failed).toMatchObject({ kind: "failed", code: "engine_failed" });
    expect(site.posts).toEqual([]);
  });

  it("no signal at all → uncertain (it may have gone through), never failed", async () => {
    const out = await run({ "/contact": (_q, res) => html(res, scripted("")) }, "/contact", { limits: { settleMs: 100, confirmMs: 1_500 } });
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal", trace: { mappedFields: ["name", "email", "phone", "message"] } });
  });
});

describe.skipIf(skipBrowser)("refusals, before anything is typed", () => {
  const page = (body: string): Record<string, Handler> => ({ "/contact": (_q, res) => html(res, body) });
  it.each([
    ["login_form", form(`<input name="user"><input type="password" name="pw"><textarea name="m"></textarea><button>Go</button>`)],
    ["file_upload", form(`${SIMPLE_FIELDS}<input type="file" name="cv" required>`)],
    ["multi_step", form(`<input name="name"><input type="email" name="email"><textarea name="m"></textarea><button type="button">Next step</button>`)],
    ["multi_step", form(`<textarea name="m"></textarea><button>Send</button>`)],
    ["consent_checkbox", form(`${SIMPLE_FIELDS}<label><input type="checkbox" name="ok" required> I accept the privacy policy</label>`)],
    ["unmapped_required", form(`${SIMPLE_FIELDS}<input name="street" placeholder="Street address" required>`)],
    ["no_form", `<h1>Call us</h1><form role="search"><input type="search" name="s"><button>Search</button></form>`],
    ["unsafe_action", form(SIMPLE_FIELDS, `method="post" action="javascript:alert(1)"`)],
  ])("%s", async (code, body) => {
    const snapshot = capturingLaunch();
    const out = await run(page(body), "/contact", { launch: snapshot.launch });
    expect(out).toMatchObject({ kind: "refused", code });
    expect(site.posts).toEqual([]);
    expect(snapshot.values()?.every((v) => v === "")).toBe(true);
  });

  it("more than one redirect", async () => {
    const out = await run({ "/a": redirectTo("/b"), "/b": redirectTo("/contact"), "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS)) }, "/a");
    expect(out).toMatchObject({ kind: "refused", code: "too_many_redirects" });
    expect(site.hits).not.toContain("GET /contact");
  });

  it("a script navigation after load counts as the second redirect too", async () => {
    const out = await run({
      "/a": redirectTo("/contact"),
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + `<script>location.href = "/elsewhere";</script>`),
      "/elsewhere": (_q, res) => html(res, form(SIMPLE_FIELDS)),
    }, "/a");
    expect(out).toMatchObject({ kind: "refused", code: "too_many_redirects" });
    expect(site.hits).not.toContain("GET /elsewhere");
  });

  it("a form page that moved to another site", async () => {
    const out = await run({ "/a": (_q, res) => html(res, "", 302, { location: `${otherSite(site.origin)}/contact` }), "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS)) }, "/a");
    expect(out).toMatchObject({ kind: "refused", code: "off_site" });
    expect(site.posts).toEqual([]);
  });

  it("images, fonts and media are never fetched", async () => {
    const out = await run({
      "/contact": (_q, res) =>
        html(res, form(SIMPLE_FIELDS) + `<img src="/logo.png"><video src="/v.mp4"></video><style>@font-face { font-family: x; src: url(/f.woff2); } body { font-family: x; }</style>`),
      "/send": thanks,
    });
    expect(out.kind).toBe("sent");
    expect(site.hits.filter((h) => /logo|v\.mp4|f\.woff2/.test(h))).toEqual([]);
  });

  it("a redirect to a javascript: URL", async () => {
    const out = await run({ "/a": redirectTo("javascript:alert(1)") }, "/a");
    expect(out).toMatchObject({ kind: "refused", code: "ssrf_blocked" });
  });

  it("an error page is a failure, not a refusal (nothing was attempted)", async () => {
    expect(await run({}, "/missing")).toMatchObject({ kind: "failed", code: "page_unavailable" });
  });
});

describe.skipIf(skipBrowser)("time limit", () => {
  it("before the click: failed (nothing submitted), and the browser is closed", async () => {
    const snapshot = capturingLaunch();
    const out = await run({ "/contact": () => undefined }, "/contact", { launch: snapshot.launch, limits: { totalMs: 2_500 } });
    expect(out).toMatchObject({ kind: "failed", code: "timeout" });
    expect(snapshot.values()).not.toBeNull();
  });

  it("after the click: uncertain", async () => {
    const out = await run(
      { "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS)), "/send": () => undefined },
      "/contact",
      { limits: { totalMs: 8_000, settleMs: 100, confirmMs: 60_000 } },
    );
    expect(out).toMatchObject({ kind: "uncertain", code: "timeout" });
    expect(site.posts.map((p) => p.path)).toEqual(["/send"]);
  });

  it("a launch failure is engine_failed", async () => {
    const out = await run({}, "/contact", { launch: () => Promise.reject(new Error("no chromium")) });
    expect(out).toMatchObject({ kind: "failed", code: "engine_failed" });
    expect(site.hits).toEqual([]);
  });
});
