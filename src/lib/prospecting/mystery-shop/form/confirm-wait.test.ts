import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY, SIMPLE_FIELDS, form, html, loopbackFetch, otherSite, ports, serve, skipBrowser, type Fixture, type Handler,
} from "@/test/form-fixture-server";
import { runFormFill, type FormRunInput } from "./engine";

/**
 * The wait after a bare 2xx (checks.ts RENDER_MS), against fixture sites in
 * the real headless Chromium: the engine knows the answer before the page
 * does, so the page gets a moment to say more — and whatever it does in that
 * moment may make the enquiry `sent` or `uncertain`, never `rejected`: the
 * site had taken it. What turns up between two looks at the page cannot be
 * timed here: checks.test.ts.
 */

let site: Fixture;
async function run(routes: Record<string, Handler>, limits: FormRunInput["limits"] = {}, identity = IDENTITY) {
  site = await serve(routes);
  return runFormFill({
    url: `${site.origin}/contact`, identity, fetchImpl: loopbackFetch(site.origin, otherSite(site.origin)),
    allowPorts: ports(site.origin), limits: { settleMs: 100, confirmMs: 4_000, ...limits },
  });
}

/** A form whose submit POSTs the enquiry by fetch, then runs `after` once it was answered. */
const contact = (after = ""): Handler => (_q, res) =>
  html(res, form(SIMPLE_FIELDS) + `<footer>Thanks for visiting</footer><script>document.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const body = new URLSearchParams(new FormData(e.target));
    fetch("/api/enquiry", { method: "POST", body }).then(() => { ${after} });
  });</script>`);
const ok: Handler = (_q, res) => html(res, "{}", 200);
const THANKS = `document.body.insertAdjacentHTML("beforeend", "<p>We'll be in touch soon.</p>")`;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await site?.close();
});

describe.skipIf(skipBrowser)("what the page says after its POST was answered", () => {
  it("thank-you text half a second later is thank_you, not post_2xx", async () => {
    const out = await run({ "/contact": contact(`setTimeout(() => ${THANKS}, 500);`), "/api/enquiry": ok });
    expect(out).toMatchObject({ kind: "sent", trace: { signal: "thank_you" } });
  });

  it("a navigation 400 ms later is the navigation, and where it went", async () => {
    const out = await run({
      "/contact": contact(`setTimeout(() => { location.href = "/done"; }, 400);`), "/api/enquiry": ok,
      "/done": (_q, res) => html(res, "<p>ok</p>"),
    });
    expect(out).toMatchObject({ kind: "sent", trace: { signal: "navigation", finalUrl: `${site.origin}/done` } });
  });

  it("a bare 2xx is not held for the whole window: thank-you text five seconds later is not waited for", async () => {
    const out = await run({ "/contact": contact(`setTimeout(() => ${THANKS}, 5000);`), "/api/enquiry": ok }, { confirmMs: 12_000 });
    expect(out).toMatchObject({ kind: "sent", trace: { signal: "post_2xx" } });
  });

  it("a 2xx still counts when the confirmation window closes before the page has had its time to say more", async () => {
    const out = await run({ "/contact": contact(), "/api/enquiry": ok }, { confirmMs: 1_200 });
    expect(out).toMatchObject({ kind: "sent", trace: { signal: "post_2xx" } });
  });
});

describe.skipIf(skipBrowser)("a taken enquiry is sent or uncertain, never rejected", () => {
  it("the page's own retry 600 ms later is told ok:false: uncertain (a refusal would invite a second enquiry)", async () => {
    const out = await run({
      "/contact": contact(`setTimeout(() => fetch("/api/enquiry", { method: "POST", body }), 600);`),
      "/api/enquiry": (_q, res) => html(res, site.posts.length === 1 ? "{}" : '{"ok":false}', 200, { "content-type": "application/json" }),
    });
    expect(site.posts).toHaveLength(2);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
    expect((out as { reason: string }).reason).toBe("The website took the enquiry, then refused a later request (ok:false); it may have gone through.");
  });

  it("only another website had answered 2xx when the form's own site refuses: still rejected (it was never taken)", async () => {
    const out = await run({
      "/contact": (_q, res) => html(res, form(SIMPLE_FIELDS) + `<script>document.querySelector("form").addEventListener("submit", (e) => {
        e.preventDefault();
        const body = new URLSearchParams(new FormData(e.target));
        fetch(location.origin.replace("127.0.0.1", "localhost") + "/collect", { method: "POST", body })
          .then(() => fetch("/api/enquiry", { method: "POST", body }));
      });</script>`),
      "/collect": (_q, res) => html(res, "{}", 200, { "access-control-allow-origin": "*" }),
      "/api/enquiry": (_q, res) => html(res, '{"ok":false}', 200, { "content-type": "application/json" }),
    });
    expect(site.posts.map((p) => p.path)).toEqual(["/collect", "/api/enquiry"]);
    expect(out).toMatchObject({ kind: "rejected", code: "form_rejected" });
  });

  it("a CAPTCHA appearing 500 ms later: uncertain/captcha_after_submit", async () => {
    const captcha = `const d = document.createElement("div"); d.className = "g-recaptcha"; document.body.append(d);`;
    const out = await run({ "/contact": contact(`setTimeout(() => { ${captcha} }, 500);`), "/api/enquiry": ok });
    expect(site.posts).toHaveLength(1);
    expect(out).toMatchObject({ kind: "uncertain", code: "captcha_after_submit" });
  });

  it("a 2xx about a second before the total deadline: uncertain/timeout (the wait is not cut short to call it sent)", async () => {
    const totalMs = 9_000;
    const started = Date.now();
    const out = await run({
      "/contact": contact(),
      // Held back until about a second before the deadline.
      "/api/enquiry": (_q, res) => void setTimeout(() => html(res, "{}", 200), Math.max(0, totalMs - 1_000 - (Date.now() - started))),
    }, { confirmMs: 15_000, totalMs });
    expect(site.posts).toHaveLength(1);
    expect(out).toMatchObject({ kind: "uncertain", code: "timeout" });
  });
});

/** A form whose submit POSTs `first` (built from the form's data `body`), then the enquiry once that was answered. */
const twoPosts = (path: string, first: string): Handler => (_q, res) =>
  html(res, form(SIMPLE_FIELDS) + `<script>document.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const body = new URLSearchParams(new FormData(e.target));
    fetch("${path}", { method: "POST", body: ${first} }).then(() => fetch("/api/enquiry", { method: "POST", body }));
  });</script>`);
const failed: Handler = (_q, res) => html(res, "", 500);

describe.skipIf(skipBrowser)("only a request carrying the message stands for the enquiry", () => {
  it("a same-site call with only our email answered 2xx, the enquiry 500: uncertain, not sent", async () => {
    const out = await run({
      "/contact": twoPosts("/api/newsletter", `new URLSearchParams({ email: body.get("email") })`),
      "/api/newsletter": ok, "/api/enquiry": failed,
    });
    expect(site.posts.map((p) => p.path)).toEqual(["/api/newsletter", "/api/enquiry"]);
    expect(site.posts[0].body).toBe("email=info%40crestahq.com");
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("a same-site call with only our email answered 2xx, the enquiry's connection dropped: uncertain, not sent", async () => {
    const out = await run({
      "/contact": twoPosts("/api/newsletter", `new URLSearchParams({ email: body.get("email") })`),
      "/api/newsletter": ok, "/api/enquiry": (_q, res) => void res.destroy(),
    });
    expect(site.posts.map((p) => p.path)).toEqual(["/api/newsletter", "/api/enquiry"]);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("the message answered 2xx at one endpoint and 422 at the enquiry's: uncertain, not post_2xx", async () => {
    const out = await run({
      "/contact": twoPosts("/api/log", "body"),
      "/api/log": ok, "/api/enquiry": (_q, res) => html(res, "", 422),
    });
    expect(site.posts.map((p) => p.path)).toEqual(["/api/log", "/api/enquiry"]);
    expect(out).toMatchObject({ kind: "uncertain", code: "no_signal" });
  });

  it("a message too short to be ours alone: the email stands for it, and a 2xx is sent", async () => {
    const out = await run({ "/contact": contact(), "/api/enquiry": ok }, {}, { ...IDENTITY, message: "Hi, quote?" });
    expect(site.posts).toHaveLength(1);
    expect(out).toMatchObject({ kind: "sent", trace: { signal: "post_2xx" } });
  });
});
