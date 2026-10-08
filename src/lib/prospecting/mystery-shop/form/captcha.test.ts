import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY, SIMPLE_FIELDS, capturingLaunch, form, html, loopbackFetch, serve, skipBrowser, type Fixture,
} from "@/test/form-fixture-server";
import { runFormFill } from "./engine";

/**
 * CAPTCHA / bot-challenge refusal: on load, and again right before the
 * submit (one injected later). Refused BEFORE anything is typed when it is
 * there on load — every input stays empty — and never submitted when it
 * appears while filling. The widget is never loaded, solved or touched.
 */

let site: Fixture;
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await site?.close();
});

async function run(body: string, title = "Contact", headers: Record<string, string> = {}) {
  site = await serve({
    "/contact": (_q, res) => html(res, body.replace("<title>Contact</title>", `<title>${title}</title>`), 200, headers),
    "/send": (_q, res) => html(res, "<h1>Thank you</h1>"),
  });
  const snapshot = capturingLaunch();
  const out = await runFormFill({
    url: `${site.origin}/contact`, identity: IDENTITY, fetchImpl: loopbackFetch(site.origin), launch: snapshot.launch,
    limits: { settleMs: 400, confirmMs: 2_000 },
  });
  return { out, typed: snapshot.values() };
}

const withForm = (extra: string) => form(`${SIMPLE_FIELDS}${extra}`);

describe.skipIf(skipBrowser)("CAPTCHA and bot challenges are refused before typing", () => {
  it.each([
    ["reCAPTCHA (script + widget)", withForm(`<script src="https://www.google.com/recaptcha/api.js" async defer></script><div class="g-recaptcha" data-sitekey="6Lc"></div>`)],
    ["reCAPTCHA v3 (script only, recaptcha.net)", withForm(`<script src="https://www.recaptcha.net/recaptcha/api.js?render=6Lc"></script>`)],
    ["reCAPTCHA via gstatic", withForm(`<script src="https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js"></script>`)],
    ["hCaptcha", withForm(`<div class="h-captcha" data-sitekey="10000000-ffff"></div><script src="https://js.hcaptcha.com/1/api.js"></script>`)],
    ["Turnstile", withForm(`<div class="cf-turnstile" data-sitekey="0x4AAA"></div>`)],
    ["Turnstile script only", withForm(`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>`)],
    ["a bare data-sitekey", withForm(`<div data-sitekey="x"></div>`)],
    ["Friendly Captcha", withForm(`<div class="frc-captcha" data-sitekey="x"></div>`)],
    ["Arkose / FunCaptcha iframe", withForm(`<iframe src="https://client-api.arkoselabs.com/fc/gc/"></iframe>`)],
    ["a captcha host in another attribute", withForm(`<div data-src="https://hcaptcha.com/checksiteconfig"></div>`)],
    ["a grecaptcha global set inline", withForm(`<script>window.grecaptcha = { ready() {} };</script>`)],
    ["a turnstile global", withForm(`<script>window.turnstile = {};</script>`)],
    ["Cloudflare challenge form", `<form id="challenge-form" action="/cdn-cgi/challenge-platform/h/b"><input name="md"><textarea></textarea><button>Go</button></form>`],
  ])("%s", async (_name, body) => {
    const { out, typed } = await run(body);
    expect(out).toMatchObject({ kind: "refused", code: "captcha" });
    expect(site.posts).toEqual([]);
    expect(typed).not.toBeNull();
    expect(typed!.every((v) => v === "")).toBe(true);
  });

  it.each(["Just a moment...", "Attention Required! | Cloudflare", "Checking your browser before accessing"])(
    "Cloudflare interstitial title %j",
    async (title) => {
      const { out, typed } = await run(form(SIMPLE_FIELDS), title);
      expect(out).toMatchObject({ kind: "refused", code: "captcha" });
      expect(typed!.every((v) => v === "")).toBe(true);
    },
  );

  it("a Cloudflare challenge response (cf-mitigated header), whatever the page says", async () => {
    const { out, typed } = await run(form(SIMPLE_FIELDS), "Contact", { "cf-mitigated": "challenge" });
    expect(out).toMatchObject({ kind: "refused", code: "captcha" });
    expect(typed!.every((v) => v === "")).toBe(true);
  });

  it("a captcha injected after load", async () => {
    const { out, typed } = await run(
      withForm(`<script>setTimeout(() => { const d = document.createElement("div"); d.className = "g-recaptcha"; document.querySelector("form").append(d); }, 100);</script>`),
    );
    expect(out).toMatchObject({ kind: "refused", code: "captcha" });
    expect(typed!.every((v) => v === "")).toBe(true);
  });

  it("a captcha injected on focus: refused before the submit, nothing posted", async () => {
    const { out } = await run(
      withForm(`<script>document.addEventListener("focusin", () => { const d = document.createElement("div"); d.className = "h-captcha"; document.body.append(d); }, { once: true });</script>`),
    );
    expect(out).toMatchObject({ kind: "refused", code: "captcha" });
    expect(site.posts).toEqual([]);
  });

  it("the captcha provider is never contacted (the request is aborted)", async () => {
    // A recaptcha URL on the fixture's own origin would reach the fixture if it were let through.
    const body = withForm(`<script src="/recaptcha/api.js"></script>`).replace("/recaptcha/api.js", "/x/www.google.com/recaptcha/api.js");
    const { out } = await run(body);
    expect(out).toMatchObject({ kind: "refused", code: "captcha" });
    expect(site.hits.filter((h) => h.includes("recaptcha"))).toEqual([]);
  });

  it("a page with no captcha is filled and sent (the control)", async () => {
    const { out } = await run(form(SIMPLE_FIELDS));
    expect(out).toMatchObject({ kind: "sent" });
    expect(site.posts).toHaveLength(1);
  });
});
