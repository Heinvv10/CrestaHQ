import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Browser } from "@playwright/test";
import { DEFAULT_BASE_URL } from "../lib/env";
import { feedPath, gbpLifecycle, primaryId, primaryRef, publicScenario, putWidget, runCron, setScenario } from "../lib/gbp";

/**
 * SP5 W1 + W2 — widget layouts and theme. On the fixture primary: a widget
 * saved without a layout is the carousel, unchanged; an admin then picks Grid,
 * Badge and a Dark theme on the dashboard card, whose preview runs the real
 * embed same-origin (no Origin header, the dashboard NOT on the allow-list);
 * and a page on an allowed origin renders each saved choice.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);
test.setTimeout(180_000);

const APP = DEFAULT_BASE_URL;
const REVIEW_TEXTS = ["Fixture review", "Fixture Reviewer", "No. r", "Thank you from the fixture team"];

/** A second, real origin for the embed (see gbp-public-feed.spec.ts for why a real loopback server). */
let site: Server;
let EXAMPLE: string;
let sitePage = "";
test.beforeAll(async () => {
  site = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(sitePage);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  EXAMPLE = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => site.close(() => resolve()));
});

/**
 * The embed on the allowed origin, in a FRESH browser context each time: the
 * feed is cacheable for 60s, and a shared HTTP cache would show the previous
 * layout. Reduced motion, so the carousel cannot move under the assertions.
 */
async function openSite(browser: Browser, publicId: string) {
  sitePage =
    `<!doctype html><title>site</title><div id="w" data-crestahq-reviews="${publicId}" data-api="${APP}"><p id="fallback">Rated on Google</p></div>` +
    `<script src="${APP}/embed/gbp-reviews.js" defer></script>`;
  const context = await browser.newContext({ reducedMotion: "reduce", storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto(`${EXAMPLE}/`);
  const widget = page.locator("#w");
  await expect(widget).toHaveAttribute("data-state", "ok", { timeout: 30_000 });
  return { widget, close: () => context.close() };
}

const savedMeta = async () => (await primaryRef().get()).data()?.gbpWidgetMeta as Record<string, unknown>;

test("layouts and theme: carousel by default, then grid, badge and dark from the dashboard", async ({ page, request, browser }) => {
  await setScenario(publicScenario());
  await runCron(request);
  await page.goto(`/sa/${primaryId()}/ai-agents/google-business`);
  await expect(page.getByTestId("gbp-widget-card")).toBeVisible({ timeout: 30_000 });

  // --- Saved WITHOUT a layout (as a pre-layouts client would): the carousel, exactly as before.
  const publicId = await putWidget(page, { enabled: true, allowedOrigins: [EXAMPLE] });
  expect(await savedMeta()).toMatchObject({ layout: "carousel", theme: "light", allowedOrigins: [EXAMPLE] });
  let s = await openSite(browser, publicId);
  await expect(s.widget.locator(".chq-reviews__carousel")).toBeVisible();
  await expect(s.widget.locator(".chq-reviews__slide")).toHaveCount(7);
  await expect(s.widget.locator(".chq-reviews__count")).toHaveText("1 / 7");
  await expect(s.widget.locator(".chq-reviews__card")).toHaveCount(0);
  await expect(s.widget.locator(".chq-reviews--dark")).toHaveCount(0);
  await s.close();

  // --- Grid, chosen on the dashboard card.
  const layout = page.getByTestId("gbp-widget-layout");
  await expect(layout).toHaveValue("carousel", { timeout: 30_000 });
  await layout.selectOption("grid");
  // The preview's feed request after the save: same-origin, so the browser sends no Origin header.
  const previewRequest = page.waitForRequest((r) => r.url().endsWith(feedPath(publicId)));
  await page.getByTestId("gbp-widget-save").click();
  await expect.poll(async () => (await savedMeta()).layout, { timeout: 30_000 }).toBe("grid");
  expect((await (await previewRequest).allHeaders())["origin"]).toBeUndefined();
  expect((await savedMeta()).allowedOrigins).toEqual([EXAMPLE]);
  expect((await savedMeta()).allowedOrigins).not.toContain(APP);
  const preview = page.getByTestId("gbp-widget-preview");
  await expect(preview.locator(".chq-reviews--grid .chq-reviews__card")).toHaveCount(7, { timeout: 30_000 });
  await expect(preview.locator(".chq-reviews__source")).toHaveText("Reviews from Google");

  s = await openSite(browser, publicId);
  const cards = s.widget.locator(".chq-reviews__card");
  await expect(cards).toHaveCount(7);
  await expect(s.widget.locator(".chq-reviews__cards")).toHaveCSS("display", "grid");
  for (let i = 0; i < 7; i++) await expect(cards.nth(i)).toBeVisible();
  await expect(cards.first().locator(".chq-reviews__text")).toHaveText("Fixture review: installed on the day promised.");
  await expect(s.widget.locator(".chq-reviews__carousel")).toHaveCount(0);
  await expect(s.widget.locator(".chq-reviews__source")).toHaveText("Reviews from Google");
  await s.close();

  // --- Badge: rating, count and attribution, and no review text at all.
  await layout.selectOption("badge");
  await page.getByTestId("gbp-widget-save").click();
  await expect.poll(async () => (await savedMeta()).layout, { timeout: 30_000 }).toBe("badge");
  await expect(preview.locator(".chq-reviews--badge")).toBeVisible({ timeout: 30_000 });
  s = await openSite(browser, publicId);
  await expect(s.widget.locator(".chq-reviews--badge")).toBeVisible();
  await expect(s.widget.locator(".chq-reviews__title")).toHaveText("Velo Test Fibre — Gqeberha");
  await expect(s.widget.locator(".chq-reviews__rating")).toHaveText("3.6 ★ · 7 reviews");
  await expect(s.widget.locator(".chq-reviews__source")).toHaveText("Reviews from Google");
  await expect(s.widget.locator(".chq-reviews__text, .chq-reviews__card, .chq-reviews__slide")).toHaveCount(0);
  const badgeText = (await s.widget.textContent()) ?? "";
  for (const t of REVIEW_TEXTS) expect(badgeText, t).not.toContain(t);
  await s.close();

  // --- Dark theme.
  await page.getByTestId("gbp-widget-theme").selectOption("dark");
  await page.getByTestId("gbp-widget-save").click();
  await expect.poll(async () => (await savedMeta()).theme, { timeout: 30_000 }).toBe("dark");
  s = await openSite(browser, publicId);
  const dark = s.widget.locator(".chq-reviews.chq-reviews--badge.chq-reviews--dark");
  await expect(dark).toBeVisible();
  await expect(dark).toHaveCSS("background-color", "rgb(17, 24, 39)");
  await expect(s.widget.locator(".chq-reviews__source")).toHaveText("Reviews from Google");
  await s.close();
});
