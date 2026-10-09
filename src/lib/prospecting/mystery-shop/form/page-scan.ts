import type { FormField } from "./mapping";

/**
 * What runs INSIDE the page, as plain JavaScript source strings: a bundler
 * transform of a TS function (helpers, renamed bindings) would break when
 * Playwright serialises it into the page, so these are never compiled. Each
 * is evaluated with `frame.evaluate(SOURCE)`; none of them types, clicks or
 * changes anything but the `data-lsms*` markers.
 */

/** Hosts and paths of CAPTCHA and bot-challenge providers (also matched on network requests). */
export const CAPTCHA_URL =
  /(google\.com|gstatic\.com|recaptcha\.net)\/recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform\/|friendlycaptcha|arkoselabs|funcaptcha/i;

/** Words a CAPTCHA, a robot check or a quiz question shows (visible text, labels, placeholders). */
export const CAPTCHA_TEXT = /captcha|not a robot|verify you are (a )?human|i'?m not a robot|anti-?spam|what is \d+\s*[+x×*-]\s*\d+/i;

/**
 * Returns a short description of the first CAPTCHA / challenge marker on the
 * page, or null: a challenge-page title, a widget's element or global, a
 * provider's host in any attribute, or CAPTCHA wording in the visible text or
 * a field's placeholder — in the document and every open shadow root (closed
 * ones are opened by OPEN_SHADOW_SCRIPT before the page runs).
 */
export const CAPTCHA_SCRIPT = `(() => {
  const URLS = new RegExp(${JSON.stringify(CAPTCHA_URL.source)}, "i");
  const TEXT = new RegExp(${JSON.stringify(CAPTCHA_TEXT.source)}, "i");
  if (/just a moment|checking your browser|attention required|verify you are (a )?human|security check/i.test(document.title)) {
    return "challenge page: " + document.title.slice(0, 80);
  }
  const SEL = '.g-recaptcha,.h-captcha,.cf-turnstile,.frc-captcha,[data-sitekey],[data-hcaptcha-widget-id],#challenge-form,' +
    '#challenge-running,#cf-challenge-running,[id^="cf-chl"],[name="g-recaptcha-response"],[name="h-captcha-response"],' +
    '[name="cf-turnstile-response"],[name="frc-captcha-solution"]';
  const all = [];
  const shadows = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (all.length >= 20000) return;
      all.push(el);
      if (el.shadowRoot) { shadows.push(el.shadowRoot); walk(el.shadowRoot); }
    }
  };
  walk(document);
  for (const el of all) {
    if (el.matches(SEL)) return "captcha element: " + el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : "");
  }
  for (const g of ["grecaptcha", "hcaptcha", "turnstile", "friendlyChallenge", "ArkoseEnforcement", "_cf_chl_opt"]) {
    if (g in window) return "captcha global: " + g;
  }
  for (const el of all) {
    for (const a of el.attributes) if (URLS.test(a.value)) return "captcha source: " + a.value.slice(0, 120);
    const hint = (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "");
    if (TEXT.test(hint)) return "captcha wording: " + hint.trim().slice(0, 80);
  }
  const texts = [document.body ? document.body.innerText || "" : "", ...shadows.map((r) => r.textContent || "")];
  for (const t of texts) {
    const m = TEXT.exec(t);
    if (m) return "captcha wording: " + m[0];
  }
  return null;
})()`;

/** Run before any page script: a closed shadow root is opened, so the CAPTCHA scan can see inside it. */
export const OPEN_SHADOW_SCRIPT = `(() => {
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { return attach.call(this, Object.assign({}, init, { mode: "open" })); };
})()`;

/** A form as page-scan saw it. Fields are marked `data-lsms="<form>-<n>"`, the submit control `data-lsms-submit`. */
export interface ScannedForm {
  index: number;
  fields: FormField[];
  /** The marker of the first visible submit control, or null. */
  submitKey: string | null;
  /** A visible next / continue / step button (a wizard). */
  nextButton: boolean;
  /** Absolute form action (attribute, resolved), and the submit control's formaction if it has one. */
  action: string;
  submitAction: string | null;
  /** A lone search box. */
  search: boolean;
}

export interface PageScan {
  password: boolean;
  forms: ScannedForm[];
}

export const SCAN_SCRIPT = `(() => {
  const visible = (el) => {
    if (el.closest('[hidden],[aria-hidden="true"]')) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 && r.right > 0 && r.bottom > 0;
  };
  const text = (el) => (el ? (el.innerText || el.textContent || "") : "").replace(/\\s+/g, " ").trim();
  // A visible-looking field a person could not type in: a honeypot. Never filled.
  const TRAP = /(^|[^a-z0-9])(hp|honeypot|trap|bot|leave[-_ ]?blank)([^a-z0-9]|$)|honeypot/i;
  const trap = (el) => {
    if (el.getAttribute("tabindex") === "-1") return true;
    if (TRAP.test(el.getAttribute("name") || "") || TRAP.test(el.id || "")) return true;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      if (/hidden|clip/.test(cs.overflow + " " + cs.overflowX + " " + cs.overflowY) && (r.width < 2 || r.height < 2)) return true;
    }
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit) return true;
    if (hit === el || el.contains(hit)) return false;
    const label = hit.closest("label");
    return !(label && (label.control === el || [...(el.labels || [])].includes(label)));
  };
  const labelOf = (el) => {
    const parts = [];
    for (const l of el.labels || []) parts.push(text(l));
    for (const id of (el.getAttribute("aria-labelledby") || "").split(/\\s+/)) if (id) parts.push(text(document.getElementById(id)));
    if (!parts.length && el.closest("label")) parts.push(text(el.closest("label")));
    return parts.join(" ");
  };
  const abs = (v) => { try { return new URL(v || "", document.baseURI).href; } catch (e) { return String(v); } };
  const SKIP = new Set(["submit", "button", "reset", "image"]);
  const forms = [...document.querySelectorAll("form")].map((form, index) => {
    const fields = [];
    let n = 0;
    for (const el of form.querySelectorAll("input, textarea, select")) {
      const tag = el.tagName.toLowerCase();
      const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : "";
      if (SKIP.has(type)) continue;
      const key = index + "-" + n++;
      el.setAttribute("data-lsms", key);
      const hint = [labelOf(el), el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.getAttribute("name"),
        el.id, el.getAttribute("autocomplete")].filter(Boolean).join(" | ").toLowerCase();
      const shown = type !== "hidden" && visible(el);
      const f = { key, tag, type, hint, required: el.required || el.getAttribute("aria-required") === "true",
        visible: shown, trap: shown && trap(el) };
      if (tag === "select") {
        f.options = [...el.options].map((o) => ({ value: o.value, text: text(o) }));
        f.value = el.value;
      }
      fields.push(f);
    }
    const submits = [...form.querySelectorAll('button[type="submit"], button:not([type]), input[type="submit"], input[type="image"]')]
      .filter(visible);
    let submitKey = null;
    if (submits[0]) { submitKey = "s" + index; submits[0].setAttribute("data-lsms-submit", submitKey); }
    const nextButton = [...form.querySelectorAll('button, input[type="button"], [role="button"]')]
      .some((b) => visible(b) && /\\b(next|continue|step|volgende)\\b/i.test(text(b) || b.value || ""));
    const shown = fields.filter((f) => f.visible);
    const search = shown.length === 1 && (shown[0].type === "search" || /(^| )(s|q|search|query)( |$)/.test(shown[0].hint));
    const formaction = submits[0] && submits[0].getAttribute("formaction");
    return { index, fields, submitKey, nextButton, action: abs(form.getAttribute("action")),
      submitAction: formaction ? abs(formaction) : null, search };
  });
  return { password: !!document.querySelector('input[type="password"]'), forms };
})()`;

/** Visible confirmation phrases on the page, counted (the count rising after the click is the signal). */
export const THANKS_SCRIPT = `(() => {
  const t = document.body ? document.body.innerText || "" : "";
  return (t.match(/thank you|thanks|received|we'll be in touch|we will be in touch|message (has been )?sent|dankie/gi) || []).length;
})()`;

/** The form with somewhere to write the enquiry: a textarea first, else the most fillable visible fields. */
export function chooseForm(forms: ScannedForm[]): ScannedForm | null {
  const usable = forms.filter((f) => !f.search && f.fields.some((x) => x.visible && !x.trap));
  const score = (f: ScannedForm) =>
    (f.fields.some((x) => x.visible && !x.trap && x.tag === "textarea") ? 1000 : 0) + f.fields.filter((x) => x.visible && !x.trap).length;
  return usable.sort((a, b) => score(b) - score(a))[0] ?? null;
}
