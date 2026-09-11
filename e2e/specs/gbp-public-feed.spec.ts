import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { readEnv } from "../lib/env";
import {
  feedPath,
  gbpLifecycle,
  primaryId,
  primaryRef,
  publicScenario,
  runCron,
  setScenario,
} from "../lib/gbp";

/**
 * E2E 4 — the public website feed. A synced fixture listing; an admin creates
 * the widget on the dashboard with https://www.velocityfibre.co.za (and the
 * local example origin) allowed. The public endpoint then serves the listing,
 * rating, count, source, freshness and reviews to that origin, refuses an
 * unapproved one, leaks nothing internal, follows a change at Google after a
 * sync with no rebuild anywhere — and the embed script renders it in a page.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);
// The edited review is awaited past the feed's 60s review-scan memo.
test.setTimeout(240_000);

const VELO = "https://www.velocityfibre.co.za";
const APP = "http://127.0.0.1:3100";

/**
 * A second, real origin for the embed: a throwaway HTTP server on a free
 * loopback port serving one page. (A page.route()-fulfilled page has no
 * address space, so Chrome's local-network check refuses its requests to the
 * app on 127.0.0.1 — a real server on loopback is what a local proof is.)
 */
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

test("the public feed serves an allowed site, refuses others, leaks nothing and follows a sync", async ({ page, request }) => {
  await setScenario(publicScenario());
  await runCron(request);

  // --- An admin creates the widget on the dashboard.
  await page.goto(`/sa/${primaryId()}/ai-agents/google-business`);
  await expect(page.getByTestId("gbp-widget-state-none")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("gbp-widget-origins").fill(`${VELO}/\n${EXAMPLE}`);
  await page.getByTestId("gbp-widget-save").click();
  const snippet = page.getByTestId("gbp-widget-snippet");
  await expect(snippet).toContainText("data-crestahq-reviews=", { timeout: 30_000 });
  const meta = (await primaryRef().get()).data()?.gbpWidgetMeta as { publicId: string; allowedOrigins: string[] };
  expect(meta.allowedOrigins).toEqual([VELO, EXAMPLE]);
  await expect(snippet).toContainText(`data-crestahq-reviews="${meta.publicId}"`);
  await expect(snippet).toContainText(`${APP}/embed/gbp-reviews.js`);

  // --- The allowed origin gets the data, with its origin echoed.
  const ok = await request.get(feedPath(meta.publicId), { headers: { Origin: VELO } });
  expect(ok.status()).toBe(200);
  expect(ok.headers()["access-control-allow-origin"]).toBe(VELO);
  // Next adds its own Vary values; ours must be among them.
  expect(ok.headers()["vary"].split(",").map((v) => v.trim())).toContain("Origin");
  expect(ok.headers()["cache-control"]).toBe("public, max-age=60");
  // A conditional request with the current ETag is a 304 from the real server, CORS intact.
  const notModified = await request.get(feedPath(meta.publicId), { headers: { Origin: VELO, "If-None-Match": ok.headers()["etag"] } });
  expect(notModified.status()).toBe(304);
  expect(notModified.headers()["access-control-allow-origin"]).toBe(VELO);
  expect(notModified.headers()["etag"]).toBe(ok.headers()["etag"]);
  const body = await ok.json();
  expect(body).toMatchObject({
    version: 1,
    status: "ok",
    listing: { title: "Velo Test Fibre — Gqeberha" },
    rating: { average: 3.6, count: 7 },
    source: { name: "Google", attribution: "Reviews from Google" },
    freshness: { stale: false },
  });
  expect(Date.now() - Date.parse(body.freshness.lastSuccessfulSyncAt)).toBeLessThan(10 * 60_000);
  expect(body.reviews).toHaveLength(7);
  expect(body.reviews.map((r: { rating: number }) => r.rating)).toEqual([5, 2, 3, 5, 4, 1, 5]);

  // --- An unapproved origin is refused, with no CORS grant.
  const evil = await request.get(feedPath(meta.publicId), { headers: { Origin: "https://evil.example" } });
  expect(evil.status()).toBe(403);
  expect(evil.headers()["access-control-allow-origin"]).toBeUndefined();

  // --- Nothing internal in the public body.
  const text = await ok.text();
  for (const marker of ["accounts/", "locations/", primaryId(), readEnv().E2E_AGENCY_ID, "@", "fake-", "token"]) {
    expect(text, marker).not.toContain(marker);
  }

  // --- A review edited at Google reaches the feed after a sync — within the
  // feed's 60s review-scan memo — with a new ETag.
  const etag = ok.headers()["etag"];
  const edited = publicScenario();
  Object.assign(edited.reviews["locations/e2e-velo-gqeberha"].reviews[0], {
    comment: "Fixture review: edited at Google after the first sync.",
    updateTime: "2026-09-10T09:00:00Z",
  });
  await setScenario(edited);
  await runCron(request);
  await expect
    .poll(async () => (await (await request.get(feedPath(meta.publicId))).json()).reviews[0].text, { timeout: 90_000, intervals: [5_000] })
    .toBe("Fixture review: edited at Google after the first sync.");
  const after = await request.get(feedPath(meta.publicId), { headers: { Origin: VELO, "If-None-Match": etag } });
  expect(after.status()).toBe(200);
  expect(after.headers()["etag"]).not.toBe(etag);

  // --- The embed script, on a page of an allowed origin, renders the live data.
  sitePage =
    `<!doctype html><title>site</title><div id="w" data-crestahq-reviews="${meta.publicId}" data-api="${APP}"><p id="fallback">Rated on Google</p></div>` +
    `<script src="${APP}/embed/gbp-reviews.js" defer></script>`;
  // Reduced motion, so auto-advance cannot move the carousel under the assertions.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${EXAMPLE}/`);
  const widget = page.locator("#w");
  await expect(widget).toHaveAttribute("data-state", "ok", { timeout: 30_000 });
  await expect(page.locator("#fallback")).toHaveCount(0);
  await expect(widget.locator(".chq-reviews__title")).toHaveText("Velo Test Fibre — Gqeberha");
  await expect(widget.locator(".chq-reviews__rating")).toContainText("7 reviews");
  await expect(widget.locator(".chq-reviews__source")).toHaveText("Reviews from Google");
  await expect(widget.locator(".chq-reviews__slide:not([hidden]) .chq-reviews__text")).toHaveText(
    "Fixture review: edited at Google after the first sync.",
  );
  await widget.getByRole("button", { name: "Next review" }).click();
  await expect(widget.locator(".chq-reviews__count")).toHaveText("2 / 7");
});
