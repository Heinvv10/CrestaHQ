import type { Locator, Page } from "@playwright/test";

/** Stateless helpers for `sp3.capture.ts` (dates, screenshots, the embedding site). */

const OUT = "docs/parity/evidence/sp3";

const now = new Date();
export const day = (n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n));
export const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const at = (d: Date, hhmm: string) => new Date(`${ymd(d)}T${hhmm}:00Z`);
export const EVERY_DAY = (startMinute: number, endMinute: number) =>
  [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startMinute, endMinute }));

export async function shot(page: Page, file: string) {
  await page.waitForTimeout(400); // let transitions settle
  await page.screenshot({ path: `${OUT}/${file}` });
}

/**
 * Shrink the dashboard's scrolling <main> so a whole section fits the
 * 1440×900 frame (the shell itself keeps its size, so nothing is blank).
 */
export async function zoom(page: Page, factor: number) {
  await page.evaluate((f) => {
    const main = document.querySelector("main");
    if (main) main.style.zoom = String(f);
  }, factor);
}

export async function toTop(locator: Locator) {
  await locator.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await locator.page().evaluate(() => window.scrollBy(0, -16));
}

/** A third-party page that embeds booking page `target` ("saId/slug") via the app's embed script. */
export function thirdPartySiteHtml(app: string, target: string): string {
  return (
    `<!doctype html><title>Glow Studio</title>` +
    `<body style="font-family:system-ui;margin:0;background:#f6f3ee">` +
    `<header style="padding:24px 48px;background:#2f2a24;color:#fff"><b>Glow Studio</b> · Hair &amp; beauty</header>` +
    `<main style="max-width:880px;margin:32px auto;padding:0 24px"><h1 style="margin:0 0 8px">Book your visit</h1>` +
    `<p style="margin:0 0 24px;color:#555">Pick a service and a time — no account needed.</p>` +
    `<div data-leadstack-booking="${target}"></div></main>` +
    `<script src="${app}/booking-embed.js"></script></body>`
  );
}
