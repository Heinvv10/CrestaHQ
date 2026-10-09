import "server-only";

import type { Page } from "playwright-core";
import { samePage, type GuardState } from "./network";
import { CAPTCHA_SCRIPT, CAPTCHA_URL, THANKS_SCRIPT } from "./page-scan";

/**
 * What engine.ts asks the page, every question bounded: a page or frame that
 * does not answer within EVALUATE_MS (a busy loop, a hung frame) is never
 * waited on. Before typing, a frame that cannot be inspected at all refuses
 * the form, like a CAPTCHA would.
 */

const EVALUATE_MS = 3_000;
const POLL_MS = 250;
/** Frames Chromium will not let a page script into: whatever is in them cannot be checked. */
const OPAQUE_FRAME = /^(file|chrome|chrome-extension|view-source|devtools):/i;

export class Stop extends Error {
  constructor(
    readonly kind: "refused" | "failed",
    readonly code: string,
    reason: string,
  ) {
    super(reason);
  }
}
export const refuse = (code: string, reason: string) => new Stop("refused", code, reason);

const TIMED_OUT = Symbol("timed out");

/** `work`, or TIMED_OUT after `ms`. */
export function bounded<T>(work: Promise<T>, ms = EVALUATE_MS): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
export const timedOut = (v: unknown): v is typeof TIMED_OUT => v === TIMED_OUT;

/** The first CAPTCHA / challenge marker, on the wire or in any frame; `opaque` = a frame it could not look into. */
async function captchaMarker(page: Page, state: GuardState): Promise<{ marker: string | null; opaque: string | null }> {
  if (state.captcha) return { marker: state.captcha, opaque: null };
  for (const frame of page.frames()) {
    const url = frame.url();
    if (OPAQUE_FRAME.test(url)) return { marker: null, opaque: url.slice(0, 80) };
    if (CAPTCHA_URL.test(url)) return { marker: `captcha frame: ${new URL(url).hostname}`, opaque: null };
    // A frame detached mid-check has nothing left to show: skipped.
    const found = await bounded(frame.evaluate(CAPTCHA_SCRIPT).catch(() => null));
    if (timedOut(found)) return { marker: null, opaque: `a frame that does not answer (${url.slice(0, 60)})` };
    if (found) return { marker: found as string, opaque: null };
  }
  return { marker: state.captcha, opaque: null };
}

/** Before the click: any marker refuses (`captcha`), and so does a frame it cannot look into. */
export async function captchaCheck(page: Page, state: GuardState): Promise<void> {
  const { marker, opaque } = await captchaMarker(page, state);
  if (opaque) throw refuse("uninspectable_frame", `Part of the page can't be checked for a CAPTCHA: ${opaque}.`);
  if (marker) throw refuse("captcha", `The form is protected by a CAPTCHA or bot check (${marker}). It is never bypassed.`);
}

export async function thanksCount(page: Page, fallback: number): Promise<number> {
  const n = await bounded(page.evaluate(THANKS_SCRIPT).catch(() => fallback));
  return timedOut(n) ? fallback : (n as number);
}

export type Outcome =
  | { signal: "navigation" | "thank_you" | "post_2xx"; finalUrl: string }
  | { captcha: string }
  | { rejected: string }
  | null;

/**
 * After the click, for up to `confirmMs`. A signal counts only once a request
 * carrying the enquiry was answered 2xx/3xx (`carrierOk`); a 2xx that says the
 * site refused it is `rejected`; a CAPTCHA appearing, or the page outgrowing
 * its budget, means it cannot be called sent (null / captcha → uncertain).
 */
export async function waitForSignal(page: Page, state: GuardState, thanksBefore: number, confirmMs: number): Promise<Outcome> {
  const until = Date.now() + confirmMs;
  const formUrl = state.formUrl ?? "";
  const captchaNow = async () => (await captchaMarker(page, state)).marker;
  while (Date.now() < until) {
    // The submit went to a refused address and nothing else was posted: nothing was sent.
    if (state.blocked && state.postsOut === 0) throw refuse("ssrf_blocked", `The form submits to a non-public address: ${state.blocked}`);
    const marker = await captchaNow();
    if (marker) return { captcha: marker };
    if (state.rejected) return { rejected: state.rejected };
    if (state.tooHeavy) return null;
    if (state.carrierOk) {
      const now = page.url();
      const seen =
        state.navigatedTo !== null
          ? ({ signal: "navigation", finalUrl: state.navigatedTo } as const)
          : /^https?:/.test(now) && !samePage(now, formUrl)
            ? ({ signal: "navigation", finalUrl: now } as const)
            : (await thanksCount(page, thanksBefore)) > thanksBefore
              ? ({ signal: "thank_you", finalUrl: now } as const)
              : state.postOk
                ? ({ signal: "post_2xx", finalUrl: now } as const)
                : null;
      if (seen) {
        const late = await captchaNow();
        return late ? { captcha: late } : state.rejected ? { rejected: state.rejected } : seen;
      }
    }
    await page.waitForTimeout(POLL_MS);
  }
  return null;
}
