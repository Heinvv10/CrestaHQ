import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY, SIMPLE_FIELDS, capturingLaunch, form, html, loopbackFetch, ports, serve, skipBrowser, type Fixture, type Handler,
} from "@/test/form-fixture-server";
import { runFormFill, type FormRunInput } from "./engine";

/**
 * The 5c breaker's attacks (review round 1), kept as regression tests: false
 * "sent" (V1), runaway pages (V3), truncation (V5), honeypots (V6), CAPTCHA
 * misses (V7) and the address tricks of a hostile form. `internal` stands for
 * the box's own network; it must never see a request.
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

const TOTAL = 12_000;
async function go(routes: (i: string) => Record<string, Handler>, over: Partial<FormRunInput> = {}) {
  site = await serve(routes(internal.origin));
  const snap = capturingLaunch();
  const t0 = Date.now();
  const out = await runFormFill({
    url: `${site.origin}/contact`, identity: IDENTITY, fetchImpl: loopbackFetch(site.origin), launch: snap.launch,
    allowPorts: ports(site.origin, internal.origin), limits: { totalMs: TOTAL, settleMs: 400, confirmMs: 3_000 }, ...over,
  });
  return { out, ms: Date.now() - t0, typed: snap.values() };
}
const ok: Handler = (_q, res) => html(res, "<h1>Thank you</h1>");
const page = (body: string): Handler => (_q, res) => html(res, body);
const onSubmit = (js: string) => form(SIMPLE_FIELDS).replace("</form>", `</form><script>document.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); ${js} });</script>`);
const sentBody = () => new URLSearchParams(site.posts.find((p) => p.path === "/send")?.body ?? "");
const T = 60_000;

describe.skipIf(skipBrowser)("a hostile page never reaches the box's network", () => {
  it.each([
    ["a 307 from the submit to an internal address", (i: string) => ({ "/contact": page(form(SIMPLE_FIELDS)), "/send": (_q: unknown, res: Parameters<Handler>[1]) => html(res, "", 307, { location: `${i}/` }) })],
    ["a script navigation to it after the click", (i: string) => ({ "/contact": page(onSubmit(`location.href = "${i}/";`)) })],
    ["a meta refresh to it on load", (i: string) => ({ "/contact": page(form(SIMPLE_FIELDS).replace("<head>", `<head><meta http-equiv="refresh" content="0;url=${i}/">`)) })],
    ["a <base href> making the action internal", (i: string) => ({ "/contact": page(form(SIMPLE_FIELDS, 'method="post" action=""').replace("<head>", `<head><base href="${i}/">`)) })],
  ] as const)("%s", async (_name, routes) => {
    const { out } = await go(routes as (i: string) => Record<string, Handler>);
    expect(internal.hits).toEqual([]);
    expect(out.trace.finalUrl ?? "").not.toMatch(/^javascript:/);
  }, T);

  it("decimal, hex, octal, v4-mapped and shorthand spellings of loopback in the action", async () => {
    const port = new URL(internal.origin).port;
    for (const host of [`2130706433:${port}`, `0x7f.1:${port}`, `017700000001:${port}`, `[::ffff:127.0.0.1]:${port}`, `127.1:${port}`, `[::1]:${port}`]) {
      const { out } = await go(() => ({ "/contact": page(form(SIMPLE_FIELDS, `method="post" action="http://${host}/"`)) }));
      expect(out, host).toMatchObject({ kind: "refused", code: "ssrf_blocked" });
      await site.close();
    }
    expect(internal.hits).toEqual([]);
  }, 200_000);

  it("a javascript: action and a data: formaction are refused", async () => {
    expect((await go(() => ({ "/contact": page(form(SIMPLE_FIELDS, `method="post" action="javascript:fetch('/x')"`)) }))).out).toMatchObject({ code: "unsafe_action" });
    await site.close();
    const data = form(SIMPLE_FIELDS.replace('<button type="submit">', '<button type="submit" formaction="data:text/html,hi">'));
    expect((await go(() => ({ "/contact": page(data) }))).out).toMatchObject({ code: "unsafe_action" });
  }, T);

  it("a 3xx to javascript: after the POST is never stored as the final URL", async () => {
    const { out } = await go(() => ({ "/contact": page(form(SIMPLE_FIELDS)), "/send": (_q, res) => html(res, "", 302, { location: "javascript:alert(1)" }) }));
    expect(out.trace.finalUrl === null || /^https?:\/\/[^?#]*$/.test(out.trace.finalUrl)).toBe(true);
  }, T);
});

describe.skipIf(skipBrowser)("runaway pages: the job always gets an answer", () => {
  it.each([
    ["a busy loop on load", { "/contact": page(form(SIMPLE_FIELDS) + "<script>while(true){}</script>") }],
    ["a busy loop after the settle", { "/contact": page(form(SIMPLE_FIELDS) + "<script>setTimeout(() => { while(true){} }, 600)</script>") }],
    ["a busy loop right after the click", { "/contact": page(onSubmit(`fetch("/send",{method:"POST",body:new FormData(e.target)}).then(()=>{ while(true){} });`)), "/send": ok }],
    ["dialogs and beforeunload", { "/contact": page(form(SIMPLE_FIELDS) + `<script>alert(1); confirm("x"); prompt("y"); addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = "stay"; }); document.addEventListener("focusin", () => alert("focus"), { once: true });</script>`), "/send": ok }],
    ["a download as the POST's answer", { "/contact": page(form(SIMPLE_FIELDS)), "/send": ((_q, res) => { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=x.exe" }); res.end("MZ"); }) as Handler }],
    ["a popup storm", { "/contact": page(form(SIMPLE_FIELDS) + `<script>for (let k=0;k<50;k++) window.open("/contact?p="+k);</script>`), "/send": ok }],
    ["a huge DOM", { "/contact": page(form(SIMPLE_FIELDS) + `<script>const d=document.createElement("div");for(let k=0;k<300000;k++){const s=document.createElement("span");s.setAttribute("data-a","x".repeat(20));d.append(s)}document.body.append(d)</script>`), "/send": ok }],
  ])("%s", async (_name, routes) => {
    const { ms } = await go(() => routes as Record<string, Handler>);
    expect(ms).toBeLessThan(TOTAL + 11_000);
  }, T);
});

describe.skipIf(skipBrowser)("no false 'sent'", () => {
  it("a 2xx JSON that says the site refused it (CF7 spam) is form_rejected", async () => {
    const { out } = await go(() => ({
      "/contact": page(onSubmit(`fetch("/wp-json/contact-form-7/v1/contact-forms/42/feedback", { method: "POST", body: new FormData(e.target) }).then((r) => r.json()).then((j) => document.body.insertAdjacentText("beforeend", j.message));`)),
      "/wp-json/contact-form-7/v1/contact-forms/42/feedback": (_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "spam", message: "Thank you, there was an error." })); },
    }));
    expect(out).toMatchObject({ kind: "rejected", code: "form_rejected" });
  }, T);

  it.each([
    ["with a same-site analytics POST every second", `<script>setInterval(() => fetch("/stats", { method: "POST", body: "pv" }), 1000);</script>`],
    ["with a testimonial slider saying thanks", `<div id="s2" style="display:none">Thanks for the quick service</div><script>setInterval(()=>{s2.style.display=s2.style.display?"":"none"},700);</script>`],
    ["with a replaceState on the invalid event", `<script>document.querySelector("form").addEventListener("invalid", () => history.replaceState(null, "", "/contact/form"), true);</script>`],
    ["alone", ""],
  ])("a form its own validation would block (pattern) is refused invalid_form, %s", async (_name, extra) => {
    const { out } = await go(() => ({
      "/contact": page(form(SIMPLE_FIELDS.replace('placeholder="Phone"', 'placeholder="Phone" pattern="0[0-9]{9}"')) + extra),
      "/stats": page("ok"), "/send": ok,
    }));
    expect(out).toMatchObject({ kind: "refused", code: "invalid_form" });
    expect(site.posts.filter((p) => p.path === "/send")).toEqual([]);
  }, T);

  it("a maxlength that truncates what was typed is refused before the submit", async () => {
    const { out } = await go(() => ({
      "/contact": page(form(SIMPLE_FIELDS.replace('type="email" name="email"', 'type="email" name="email" maxlength="16"'))), "/send": ok,
    }));
    expect(out).toMatchObject({ kind: "refused", code: "field_truncated" });
    expect(site.posts).toEqual([]);
  }, T);

  it.each([
    ["inside a zero-height overflow:hidden parent", `<div style="height:0;overflow:hidden"><label>Confirm email <input type="email" name="email_confirm"></label></div>`, "email_confirm"],
    ["under an opaque cover", `<div style="position:relative"><input name="contact_name" placeholder="Name" style="position:absolute;top:0;left:0;z-index:-1"><div style="position:relative;background:#fff;height:30px"></div></div>`, "contact_name"],
    ["with tabindex=-1", `<input name="company" placeholder="Company" tabindex="-1">`, "company"],
    ["named like a trap", `<input name="leave_blank" placeholder="Your name">`, "leave_blank"],
  ])("a honeypot %s is never filled", async (_name, trap, name) => {
    const { out } = await go(() => ({ "/contact": page(form(trap + SIMPLE_FIELDS)), "/send": ok }));
    expect(out.kind).toBe("sent");
    expect(sentBody().get(name)).toBe("");
  }, T);

  it("a REQUIRED honeypot refuses the form", async () => {
    const { out } = await go(() => ({ "/contact": page(form(`<input name="website_hp" placeholder="Website" required>` + SIMPLE_FIELDS)) }));
    expect(out).toMatchObject({ kind: "refused", code: "honeypot_required" });
  }, T);
});

describe.skipIf(skipBrowser)("partial-lead capture", () => {
  it("a page posting each field as it is typed, then a lazy CAPTCHA: refused, and NOTHING of the enquiry left", async () => {
    const js = `document.querySelectorAll("input, textarea").forEach((el) => el.addEventListener("input", () =>
        fetch("/capture?" + el.name + "=" + encodeURIComponent(el.value), { method: "POST", body: el.name + "=" + encodeURIComponent(el.value) }).catch(() => {})));
      document.querySelector("textarea").addEventListener("focus", () => { const d = document.createElement("div"); d.className = "g-recaptcha"; document.body.append(d); });`;
    const { out } = await go(() => ({ "/contact": page(form(SIMPLE_FIELDS) + `<script>${js}</script>`), "/capture": page("ok"), "/send": ok }));
    expect(out).toMatchObject({ kind: "refused", code: "captcha" });
    const leaked = site.hits.concat(site.posts.map((p) => p.body)).join("\n");
    expect(decodeURIComponent(leaked)).not.toContain(IDENTITY.email);
    expect(site.posts).toEqual(site.posts.filter((p) => !p.body.includes("crestahq")));
  }, T);

  it("without a CAPTCHA the form still goes, and the early copies never left", async () => {
    const js = `document.querySelector("[name=email]").addEventListener("change", (e) => fetch("/capture", { method: "POST", body: "email=" + encodeURIComponent(e.target.value) }).catch(() => {}));`;
    const { out } = await go(() => ({ "/contact": page(form(SIMPLE_FIELDS) + `<script>${js}</script>`), "/capture": page("ok"), "/send": ok }));
    expect(out.kind).toBe("sent");
    expect(site.posts.map((p) => p.path)).toEqual(["/send"]);
  }, T);
});

describe.skipIf(skipBrowser)("CAPTCHA misses", () => {
  it("a reCAPTCHA loaded by the click itself: uncertain, never sent", async () => {
    const lazy = `<script>let L=0;document.addEventListener("mousedown",()=>{if(L++)return;const s=document.createElement("script");s.src="https://www.goo"+"gle.com/recap"+"tcha/api.js";document.head.append(s);},true);</script>`;
    const { out } = await go(() => ({ "/contact": page(form(SIMPLE_FIELDS).replace("</form>", `</form>${lazy}`)), "/send": ok }));
    expect(out).toMatchObject({ kind: "uncertain", code: "captcha_after_submit" });
  }, T);

  it.each([
    ["inside a closed shadow root", form(SIMPLE_FIELDS.replace("<button", "<x-cap></x-cap><button")) + `<script>customElements.define("x-cap", class extends HTMLElement { constructor(){ super(); const r=this.attachShadow({mode:"closed"}); r.innerHTML='<div class="h-captcha" data-sitekey="x"></div>'; } });</script>`],
    ["an unknown provider's frame saying 'not a robot'", form(SIMPLE_FIELDS.replace("<button", `<iframe src="/cap"></iframe><button`))],
    ["a maths question", form(SIMPLE_FIELDS.replace("<button", '<label>What is 3 + 4? <input name="quiz"></label><button'))],
    ["anti-spam wording in a placeholder", form(SIMPLE_FIELDS.replace("<button", '<input name="q" placeholder="Anti-spam: type the word blue"><button'))],
  ])("%s is refused before typing", async (_name, body) => {
    const { out, typed } = await go(() => ({ "/contact": page(body), "/cap": page("<p>I am not a robot <input type=checkbox></p>"), "/send": ok }));
    expect(out).toMatchObject({ kind: "refused", code: "captcha" });
    expect(typed!.every((v) => v === "")).toBe(true);
  }, T);

  it("a Cloudflare challenge answered 403 is a CAPTCHA, not a dead page", async () => {
    const { out } = await go(() => ({
      "/contact": (_q, res) => html(res, `<title>Just a moment...</title>${form(SIMPLE_FIELDS)}`, 403, { "cf-mitigated": "challenge" }),
    }));
    expect(out).toMatchObject({ kind: "refused", code: "captcha" });
  }, T);
});
