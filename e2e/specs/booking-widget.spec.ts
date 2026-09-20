import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { baseURL, readEnv } from "../lib/env";
import { ensureWidgetBookingPage, ownerUid } from "../lib/seed";

/**
 * SP3 (e) — the embeddable booking widget (W1) and the reschedule/cancel
 * manage link (W2).
 *
 * Anonymous throughout: a real visitor has no session, and the widget must
 * work on a THIRD-PARTY site, not just on our own app's origin.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(90_000);

/**
 * A second, real origin for the embed: a throwaway HTTP server on a free
 * loopback port serving one page. (A page.route()-fulfilled page has no
 * address space, so Chrome's local-network check refuses its requests to
 * the app on 127.0.0.1 — a real server on loopback is what a local proof
 * is. Same trick as e2e/specs/gbp-public-feed.spec.ts.)
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

test("the booking widget embeds on a third-party site, books, redirects the TOP window, and its manage link reschedules + cancels", async ({
  page,
}) => {
  const env = readEnv();
  const saId = env.E2E_SUBACCOUNT_ID;
  const uid = await ownerUid(env.E2E_AGENCY_ID);
  const APP = baseURL();
  // Redirect target: a page on the SAME throwaway server, different path, so
  // a same-frame (broken) redirect and a top-window (correct) redirect are
  // both easy to tell apart from where `page.url()` ends up.
  const redirectTarget = `${EXAMPLE}/thanks`;
  const slug = await ensureWidgetBookingPage(
    env.E2E_AGENCY_ID,
    saId,
    uid,
    redirectTarget,
  );

  // --- Response headers on the embed route allow framing.
  const embedRes = await page.request.get(`${APP}/embed/booking/${saId}/${slug}`);
  expect(embedRes.status()).toBe(200);
  expect(embedRes.headers()["content-security-policy"]).toContain(
    "frame-ancestors *",
  );

  // --- A host page on a DIFFERENT origin embeds the widget via the
  // script+div snippet the Embed dialog hands out.
  sitePage =
    `<!doctype html><title>host</title>` +
    `<div data-leadstack-booking="${saId}/${slug}"></div>` +
    `<script src="${APP}/booking-embed.js"></script>`;

  await page.goto(`${EXAMPLE}/`);
  const iframeEl = page.locator("iframe");
  await expect(iframeEl).toBeVisible({ timeout: 30_000 });
  const frame = page.frameLocator("iframe");

  // The picker loaded real availability inside the iframe (not a 404 / error).
  await expect(
    frame.getByRole("heading", { name: /30 min booking/i }),
  ).toBeVisible({ timeout: 30_000 });

  // Pick the first time on the NEXT day, never the first offered: that one
  // can start the instant it is booked — offered at 06:29:59.9, booked at
  // 06:30:00.1, refused 409 "That slot was just taken" (CI run 35059398689).
  const slotButtons = frame.getByRole("button", { name: /\d{1,2}:\d{2}/ });
  await expect(slotButtons.first()).toBeVisible({ timeout: 30_000 });
  const firstDay = await frame.getByRole("heading", { level: 2 }).textContent();
  await frame.getByRole("button", { name: "Next day" }).click();
  await expect(frame.getByRole("heading", { level: 2 })).not.toHaveText(firstDay ?? "");
  await slotButtons.first().click();

  const stamp = Date.now();
  const email = `e2e-booking-widget-${stamp}@example.com`;
  await frame.locator("#b-name").fill("E2E Widget Visitor");
  await frame.locator("#b-email").fill(email);
  await frame.locator("#b-phone").fill("+15550001111");

  const bookResponse = page.waitForResponse(
    (res) =>
      /\/api\/booking\/.+\/book$/.test(res.url()) &&
      res.request().method() === "POST",
  );
  await frame.getByRole("button", { name: /confirm booking/i }).click();
  const bookRes = await bookResponse;
  expect(bookRes.status()).toBe(200);
  const bookBody = (await bookRes.json()) as {
    ok: boolean;
    eventId: string;
    publicEventUrl: string;
    redirectUrl: string | null;
  };
  expect(bookBody.ok).toBe(true);
  expect(bookBody.redirectUrl).not.toBeNull();
  expect(bookBody.redirectUrl).toMatch(new RegExp(`^${redirectTarget}\\?`));

  await expect(frame.getByText(/you're booked/i)).toBeVisible({
    timeout: 15_000,
  });

  // The event doc exists, tied to the fixture sub-account.
  const eventSnap = await adminDb()
    .collection("events")
    .doc(bookBody.eventId)
    .get();
  expect(eventSnap.exists).toBe(true);
  expect(eventSnap.data()?.subAccountId).toBe(saId);

  // --- The redirect CTA is a click, not an unattended timer: per the HTML
  // "allowed to navigate" algorithm (enforced by Chrome), a cross-origin
  // iframe may only navigate the top browsing context with a live user
  // gesture — a `setTimeout` has none. Clicking `target="_top"` inside the
  // iframe navigates the TOP window, not the iframe. A same-frame
  // regression would leave the top-level page sitting on EXAMPLE's "/"
  // forever (only the iframe's own location would change) — this
  // assertion on the TOP-LEVEL page's URL is exactly what catches that.
  await frame.getByRole("link", { name: /continue/i }).click();
  await expect
    .poll(() => page.url(), { timeout: 10_000 })
    .toBe(bookBody.redirectUrl);

  // --- W2: the manage link from the SAME book response reschedules and
  // cancels. Read from the API response, not Firestore — only the token's
  // hash persists there.
  await page.goto(bookBody.publicEventUrl);
  await expect(page.getByText(/confirmed/i)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /reschedule/i }).click();
  const newSlotButtons = page.getByRole("button", { name: /(am|pm)$/i });
  await expect(newSlotButtons.first()).toBeVisible({ timeout: 15_000 });
  // Not the first offered time either — same boundary as the booking above.
  await newSlotButtons.nth(2).click();
  await page.getByRole("button", { name: /confirm new time/i }).click();
  await expect(page.getByText(/rescheduled/i)).toBeVisible({ timeout: 15_000 });

  const rescheduled = await adminDb()
    .collection("events")
    .doc(bookBody.eventId)
    .get();
  const rescheduledStart = (
    rescheduled.data()?.startAt as { toDate?: () => Date } | null
  )?.toDate?.();
  expect(rescheduledStart).toBeInstanceOf(Date);

  // Reschedule rotates the token — the page updates its own URL in place
  // (window.history.replaceState), so the cancel below is exercised through
  // whatever `page.url()` now is, proving the new token itself works too.
  await page.getByRole("button", { name: /cancel booking/i }).click();
  await page.getByRole("button", { name: /yes, cancel/i }).click();
  await expect(page.getByText(/booking has been cancelled/i)).toBeVisible({
    timeout: 15_000,
  });

  const cancelled = await adminDb()
    .collection("events")
    .doc(bookBody.eventId)
    .get();
  expect(cancelled.data()?.status).toBe("cancelled");
});
