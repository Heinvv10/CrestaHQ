import "server-only";

import type { Page } from "playwright-core";
import { sameSite } from "@/lib/prospecting/registrable-domain";
import { launchFormBrowser, type FormBrowser } from "./browser";
import { planFields, type FieldRole, type FormIdentity } from "./mapping";
import { defaultFetch, installNetworkGuard, newGuardState, type FetchImpl, type GuardState } from "./network";
import { OPEN_SHADOW_SCRIPT, SCAN_SCRIPT, chooseForm, type PageScan } from "./page-scan";
import { enquiryMarkers } from "./evidence";
import { MARK_FORM_PAGE, Stop, bounded, captchaCheck, refuse, thanksCount, timedOut, waitForSignal } from "./checks";

/**
 * One website contact-form fill, headless (PR 5c). Opens the form URL (at
 * most one redirect, every request through network.ts), refuses before
 * typing anything on a CAPTCHA / bot challenge, a password field, a missing
 * or multi-step form, or a field it cannot fill truthfully (mapping.ts),
 * fills the workspace's identity and the enquiry, checks for a CAPTCHA again,
 * reads every field back (a truncated or masked value refuses), refuses a
 * form the browser itself calls invalid, then clicks submit. Success is a
 * confirmation signal within CONFIRM_MS — a main-frame navigation to another
 * URL, new thank-you text, or a 2xx on the form's site or a known form
 * backend — and only once a request carrying the enquiry was answered 2xx/3xx
 * (checks.ts). A 2xx that says the site refused it is `rejected`. No signal,
 * a CAPTCHA appearing after the click, or such a refusal once the site had
 * already taken the enquiry = uncertain (it may have gone through). Never
 * solves, bypasses or touches a CAPTCHA.
 *
 * Hard limit TOTAL_MS: past it, before the click = failed (nothing sent);
 * after the click = uncertain. The browser is always closed, and the job gets
 * its answer within CLOSE_MS of the deadline whatever the page does.
 *
 * The single entry point: everything it needs is in FormRunInput, so it can
 * move to its own process unchanged.
 */

const TOTAL_MS = 45_000;
const SETTLE_MS = 1_500;
const CONFIRM_MS = 15_000;
const CLOSE_MS = 5_000;
/** No peer-to-peer or QUIC transports in the page: they could reach the network outside the route. */
const NO_PEER_SCRIPT = `for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebTransport"]) {
  try { Object.defineProperty(window, k, { value: undefined, configurable: false }); } catch (e) { void e; }
}`;

export type FormSignal = "navigation" | "thank_you" | "post_2xx";

/** Member-only (`formTrace` on the shop): never the values typed. */
export interface FormTrace {
  finalUrl: string | null;
  signal: FormSignal | null;
  mappedFields: FieldRole[];
}

export type FormResult =
  | { kind: "sent"; trace: FormTrace }
  | { kind: "uncertain"; code: "no_signal" | "timeout" | "captcha_after_submit"; reason: string; trace: FormTrace }
  | { kind: "refused"; code: string; reason: string; trace: FormTrace }
  | { kind: "failed"; code: "engine_failed" | "engine_unisolated" | "page_unavailable" | "page_too_heavy" | "timeout"; reason: string; trace: FormTrace }
  /** The site answered the enquiry with a refusal (a 2xx saying so): it went out, so the slot is kept; never public. */
  | { kind: "rejected"; code: "form_rejected"; reason: string; trace: FormTrace };

export interface FormRunInput {
  url: string;
  identity: FormIdentity;
  fetchImpl?: FetchImpl;
  /** Awaited right before the click: after it, a crash or timeout is an uncertain send. */
  onBeforeSubmit?: () => Promise<void>;
  launch?: () => Promise<FormBrowser>;
  limits?: { totalMs?: number; settleMs?: number; confirmMs?: number };
  /** Test-only: explicit ports allowed besides 80 / 443 (the local fixture's). */
  allowPorts?: string[];
}

/** The trace keeps where the page ended: http(s) only, without its query or fragment. */
export function traceUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}${u.pathname}` : null;
  } catch {
    return null;
  }
}

const MAYBE_SENT = "The form was submitted but showed no confirmation; it may have gone through.";
const TEXTLIKE = new Set(["", "text", "email", "tel", "url", "number", "search"]);

/** The form page, at most one redirect; refusals for a blocked address, a second redirect or an error page. */
async function load(page: Page, url: string, state: GuardState): Promise<void> {
  let next: string | null = url;
  for (let hop = 0; next !== null; hop++) {
    const target: string = next;
    next = null;
    state.redirect = null;
    const res = await page.goto(target, { waitUntil: "load" }).catch((err: unknown) => {
      // A redirect or a refusal cancels the navigation on purpose; anything else is a real failure.
      if (state.redirect || state.blocked || state.tooManyRedirects || state.fetchError) return null;
      throw err;
    });
    if (state.blocked) throw refuse("ssrf_blocked", `The form page is not on the public internet: ${state.blocked}`);
    // A challenge answered with an error status (Cloudflare's 403 + cf-mitigated) is a CAPTCHA, not a dead page.
    if (state.captcha) throw refuse("captcha", `The form is protected by a CAPTCHA or bot check (${state.captcha}). It is never bypassed.`);
    if (state.tooManyRedirects || (state.redirect && hop >= 1)) {
      throw refuse("too_many_redirects", "The form page redirected more than once.");
    }
    if (state.fetchError) throw new Stop("failed", "page_unavailable", `The form page could not be loaded: ${state.fetchError}`);
    if (state.redirect) next = state.redirect;
    else if (res && res.status() >= 400) {
      throw new Stop("failed", "page_unavailable", `The form page could not be loaded (HTTP ${res.status()}).`);
    }
  }
}

export async function runFormFill(input: FormRunInput): Promise<FormResult> {
  const totalMs = input.limits?.totalMs ?? TOTAL_MS;
  const controller = new AbortController();
  const state = newGuardState();
  const trace: FormTrace = { finalUrl: null, signal: null, mappedFields: [] };
  let browser: FormBrowser | null = null;
  let clicked = false;

  const work = async (): Promise<FormResult> => {
    try {
      browser = await (input.launch ?? launchFormBrowser)();
    } catch (err) {
      console.error("[mystery-shop/form] chromium launch failed", err);
      return { kind: "failed", code: "engine_failed", reason: "The form engine could not start.", trace };
    }
    if (controller.signal.aborted) throw new Error("timed out during launch");
    const { context } = browser;
    // Only an http(s) page on 80 / 443 is ever opened: file:, data:, javascript: and the rest never reach the route.
    const start = new URL(input.url);
    if ((start.protocol !== "http:" && start.protocol !== "https:") || !(start.port === "" || (input.allowPorts ?? []).includes(start.port))) {
      return { kind: "refused", code: "ssrf_blocked", reason: `The form address is not a public web page (${start.protocol}).`, trace };
    }
    await context.addInitScript(NO_PEER_SCRIPT);
    await context.addInitScript(OPEN_SHADOW_SCRIPT);
    const page = await context.newPage();
    page.setDefaultTimeout(totalMs);
    await installNetworkGuard(context, page, {
      fetchImpl: input.fetchImpl ?? defaultFetch, signal: controller.signal, state, markers: enquiryMarkers(input.identity),
      allowPorts: input.allowPorts,
    });
    try {
      await load(page, input.url, state);
      await page.waitForTimeout(input.limits?.settleMs ?? SETTLE_MS);
      if (state.tooHeavy) throw new Stop("failed", "page_too_heavy", "The form page asked for too much; nothing was submitted.");
      if (state.tooManyRedirects) throw refuse("too_many_redirects", "The form page redirected more than once.");
      trace.finalUrl = traceUrl(page.url());
      if (!sameSite(new URL(page.url()).hostname, new URL(input.url).hostname)) {
        throw refuse("off_site", "The form page moved to another website.");
      }
      state.formUrl = page.url();
      await captchaCheck(page, state);

      const scanned = await bounded(page.evaluate(SCAN_SCRIPT));
      if (timedOut(scanned)) throw refuse("uninspectable_frame", "The page did not answer while the form was read.");
      const scan = scanned as PageScan;
      if (scan.password) throw refuse("login_form", "The page asks for a password (a login form).");
      const form = chooseForm(scan.forms);
      if (!form) throw refuse("no_form", "No contact form was found on the page.");
      const fillable = form.fields.filter((f) => f.visible && !f.trap && (f.tag !== "input" || TEXTLIKE.has(f.type))).length;
      if ((!form.submitKey && form.nextButton) || fillable < 2) throw refuse("multi_step", "The form has several steps.");
      const action = new URL(form.submitAction ?? form.action);
      if (action.protocol !== "http:" && action.protocol !== "https:") {
        throw refuse("unsafe_action", `The form does not submit to a web address (${action.protocol}).`);
      }
      const plan = planFields(form.fields, input.identity);
      if (!plan.ok) throw refuse(plan.code, plan.reason);
      trace.mappedFields = plan.roles;

      for (const fill of plan.fills) {
        await captchaCheck(page, state);
        const field = page.locator(`[data-lsms="${fill.key}"]`);
        if (fill.kind === "select") await field.selectOption(fill.value);
        else await field.fill(fill.value);
        // What the page kept is what is sent: a maxlength or an input mask that changed it refuses.
        if ((await field.inputValue()) !== fill.value) {
          throw refuse("field_truncated", `The form changed what was typed into its ${fill.role} field.`);
        }
      }
      await captchaCheck(page, state);
      const valid = await bounded(page.evaluate(`document.querySelectorAll("form")[${form.index}].checkValidity()`));
      if (valid !== true) throw refuse("invalid_form", "The form would not accept the values (its own validation failed).");
      const thanksBefore = await thanksCount(page, 0);
      await bounded(page.evaluate(MARK_FORM_PAGE));
      await input.onBeforeSubmit?.();
      // The deadline passed while the submit was being stamped: the job has its answer; never click after it.
      if (controller.signal.aborted) throw new Error("deadline passed before the click");
      state.clickedAt = Date.now();
      clicked = true;
      if (form.submitKey) await page.locator(`[data-lsms-submit="${form.submitKey}"]`).click({ noWaitAfter: true });
      else await bounded(page.evaluate(`document.querySelectorAll("form")[${form.index}].requestSubmit()`));

      const seen = await waitForSignal(page, state, thanksBefore, input.limits?.confirmMs ?? CONFIRM_MS);
      const ended = { ...trace, finalUrl: traceUrl(page.url()) };
      if (seen === null) return { kind: "uncertain", code: "no_signal", reason: MAYBE_SENT, trace: ended };
      if ("captcha" in seen) {
        const reason = `A CAPTCHA appeared after the submit (${seen.captcha}); it may not have gone through.`;
        return { kind: "uncertain", code: "captcha_after_submit", reason, trace: ended };
      }
      if ("rejected" in seen) {
        return { kind: "rejected", code: "form_rejected", reason: `The website refused the enquiry (${seen.rejected}).`, trace: ended };
      }
      if ("refusedLate" in seen) {
        const reason = `The website took the enquiry, then refused a later request (${seen.refusedLate}); it may have gone through.`;
        return { kind: "uncertain", code: "no_signal", reason, trace: ended };
      }
      return { kind: "sent", trace: { ...trace, signal: seen.signal, finalUrl: traceUrl(seen.finalUrl) } };
    } catch (err) {
      if (err instanceof Stop) return { kind: err.kind, code: err.code, reason: err.message, trace } as FormResult;
      throw err;
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), totalMs);
  });
  const running = work();
  try {
    const outcome = await Promise.race([running, deadline]);
    if (outcome !== "timeout") return outcome;
    controller.abort();
    return clicked
      ? { kind: "uncertain", code: "timeout", reason: `${MAYBE_SENT} (It ran out of time.)`, trace }
      : { kind: "failed", code: "timeout", reason: "The form took too long; nothing was submitted.", trace };
  } catch (err) {
    console.error("[mystery-shop/form] form fill crashed", err);
    return clicked
      ? { kind: "uncertain", code: "no_signal", reason: MAYBE_SENT, trace }
      : { kind: "failed", code: "engine_failed", reason: "The form engine stopped unexpectedly; nothing was submitted.", trace };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await bounded((browser as FormBrowser | null)?.close() ?? Promise.resolve(), CLOSE_MS).catch((err: unknown) =>
      console.error("[mystery-shop/form] browser close failed", err),
    );
    // A launch still in flight at the deadline closes its own browser once it lands — bounded, so the job always returns.
    const closeLate = () => (browser as FormBrowser | null)?.close();
    await bounded(running.then(closeLate, closeLate), CLOSE_MS).catch((err: unknown) =>
      console.error("[mystery-shop/form] browser close failed", err),
    );
  }
}
