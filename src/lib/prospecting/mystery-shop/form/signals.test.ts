import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY, SIMPLE_FIELDS, form, html, loopbackFetch, ports, serve, skipBrowser, type Fixture, type Handler,
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
    url: `${site.origin}${path}`, identity: IDENTITY, fetchImpl: loopbackFetch(site.origin),
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
