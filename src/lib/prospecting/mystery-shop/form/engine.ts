import "server-only";

import type { Browser, Page } from "playwright-core";
import { sameSite } from "@/lib/prospecting/registrable-domain";
import { launchFormBrowser } from "./browser";
import { planFields, type FieldRole, type FormIdentity } from "./mapping";
import { defaultFetch, installNetworkGuard, newGuardState, type FetchImpl, type GuardState } from "./network";
import { CAPTCHA_SCRIPT, CAPTCHA_URL, SCAN_SCRIPT, THANKS_SCRIPT, chooseForm, type PageScan } from "./page-scan";

/**
 * One website contact-form fill, headless (PR 5c). Opens the form URL (at
 * most one redirect, every request through network.ts), refuses before
 * typing anything on a CAPTCHA / bot challenge, a password field, a missing
 * or multi-step form, or a field it cannot fill truthfully (mapping.ts),
 * fills the workspace's identity and the enquiry, checks for a CAPTCHA again,
 * then clicks submit. Success is a confirmation signal within CONFIRM_MS: a
 * main-frame navigation to another URL, new thank-you text, or a 2xx to a
 * POST on the form's site or a known form backend. No signal = uncertain (it
 * may have gone through). Never solves, bypasses or touches a CAPTCHA.
 *
 * Hard limit TOTAL_MS: past it, before the click = failed (nothing sent);
 * after the click = uncertain. The browser is always closed.
 */

export const TOTAL_MS = 45_000;
const SETTLE_MS = 1_500;
const CONFIRM_MS = 15_000;
const POLL_MS = 250;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
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
  | { kind: "uncertain"; code: "no_signal" | "timeout"; reason: string; trace: FormTrace }
  | { kind: "refused"; code: string; reason: string; trace: FormTrace }
  | { kind: "failed"; code: "engine_failed" | "page_unavailable" | "timeout"; reason: string; trace: FormTrace };

export interface FormRunInput {
  url: string;
  identity: FormIdentity;
  fetchImpl?: FetchImpl;
  /** Awaited right before the click: after it, a crash or timeout is an uncertain send. */
  onBeforeSubmit?: () => Promise<void>;
  launch?: () => Promise<Browser>;
  limits?: { totalMs?: number; settleMs?: number; confirmMs?: number };
}

class Stop extends Error {
  constructor(
    readonly kind: "refused" | "failed",
    readonly code: string,
    reason: string,
  ) {
    super(reason);
  }
}
const refuse = (code: string, reason: string) => new Stop("refused", code, reason);

const MAYBE_SENT = "The form was submitted but showed no confirmation; it may have gone through.";
const TEXTLIKE = new Set(["", "text", "email", "tel", "url", "number", "search"]);

async function captchaCheck(page: Page, state: GuardState): Promise<void> {
  let marker = state.captcha;
  for (const frame of marker ? [] : page.frames()) {
    if (CAPTCHA_URL.test(frame.url())) marker = `captcha frame: ${new URL(frame.url()).hostname}`;
    marker ??= (await frame.evaluate(CAPTCHA_SCRIPT).catch(() => null)) as string | null;
    if (marker) break;
  }
  if (marker) throw refuse("captcha", `The form is protected by a CAPTCHA or bot check (${marker}). It is never bypassed.`);
}

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

async function waitForSignal(page: Page, state: GuardState, thanksBefore: number, confirmMs: number) {
  const until = Date.now() + confirmMs;
  const formUrl = state.formUrl ?? "";
  const bare = (u: string) => u.replace(/#.*$/, "");
  while (Date.now() < until) {
    // The submit went to a refused address and nothing else was posted: nothing was sent.
    if (state.blocked && state.postsOut === 0) throw refuse("ssrf_blocked", `The form submits to a non-public address: ${state.blocked}`);
    if (state.navigatedTo) return { signal: "navigation" as const, finalUrl: state.navigatedTo };
    // A page URL change (a history push, a finished navigation), never Chromium's own error page.
    const now = page.url();
    if (/^https?:/.test(now) && bare(now) !== bare(formUrl)) return { signal: "navigation" as const, finalUrl: now };
    const thanks = (await page.evaluate(THANKS_SCRIPT).catch(() => thanksBefore)) as number;
    if (thanks > thanksBefore) return { signal: "thank_you" as const, finalUrl: now };
    if (state.postOk) return { signal: "post_2xx" as const, finalUrl: now };
    await page.waitForTimeout(POLL_MS);
  }
  return null;
}

export async function runFormFill(input: FormRunInput): Promise<FormResult> {
  const totalMs = input.limits?.totalMs ?? TOTAL_MS;
  const controller = new AbortController();
  const state = newGuardState();
  const trace: FormTrace = { finalUrl: null, signal: null, mappedFields: [] };
  let browser: Browser | null = null;
  let clicked = false;

  const work = async (): Promise<FormResult> => {
    try {
      browser = await (input.launch ?? launchFormBrowser)();
    } catch (err) {
      console.error("[mystery-shop/form] chromium launch failed", err);
      return { kind: "failed", code: "engine_failed", reason: "The form engine could not start.", trace };
    }
    if (controller.signal.aborted) throw new Error("timed out during launch");
    const context = await browser.newContext({
      serviceWorkers: "block", acceptDownloads: false, javaScriptEnabled: true, userAgent: USER_AGENT, locale: "en-ZA",
      viewport: { width: 1280, height: 900 },
    });
    await context.addInitScript(NO_PEER_SCRIPT);
    const page = await context.newPage();
    page.setDefaultTimeout(totalMs);
    await installNetworkGuard(context, page, { fetchImpl: input.fetchImpl ?? defaultFetch, signal: controller.signal, state });
    try {
      await load(page, input.url, state);
      await page.waitForTimeout(input.limits?.settleMs ?? SETTLE_MS);
      if (state.tooManyRedirects) throw refuse("too_many_redirects", "The form page redirected more than once.");
      trace.finalUrl = page.url();
      if (!sameSite(new URL(page.url()).hostname, new URL(input.url).hostname)) {
        throw refuse("off_site", "The form page moved to another website.");
      }
      state.formUrl = page.url();
      await captchaCheck(page, state);

      const scan = (await page.evaluate(SCAN_SCRIPT)) as PageScan;
      if (scan.password) throw refuse("login_form", "The page asks for a password (a login form).");
      const form = chooseForm(scan.forms);
      if (!form) throw refuse("no_form", "No contact form was found on the page.");
      const fillable = form.fields.filter((f) => f.visible && (f.tag !== "input" || TEXTLIKE.has(f.type))).length;
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
      }
      await captchaCheck(page, state);
      const thanksBefore = (await page.evaluate(THANKS_SCRIPT)) as number;
      await input.onBeforeSubmit?.();
      state.clickedAt = Date.now();
      clicked = true;
      if (form.submitKey) await page.locator(`[data-lsms-submit="${form.submitKey}"]`).click({ noWaitAfter: true });
      else await page.evaluate(`document.querySelectorAll("form")[${form.index}].requestSubmit()`);

      const seen = await waitForSignal(page, state, thanksBefore, input.limits?.confirmMs ?? CONFIRM_MS);
      if (!seen) return { kind: "uncertain", code: "no_signal", reason: MAYBE_SENT, trace: { ...trace, finalUrl: page.url() } };
      return { kind: "sent", trace: { ...trace, ...seen } };
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
    await (browser as Browser | null)?.close().catch((err: unknown) => console.error("[mystery-shop/form] browser close failed", err));
    // A launch still in flight at the deadline closes its own browser once it lands.
    await running.then(
      () => (browser as Browser | null)?.close(),
      () => (browser as Browser | null)?.close(),
    ).catch((err: unknown) => console.error("[mystery-shop/form] browser close failed", err));
  }
}
