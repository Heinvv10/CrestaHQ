import { expect, test, type Browser, type Page } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import sharp from "sharp";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { pageFetch } from "../lib/gbp";
import { assertFixtureSubAccount } from "../lib/guard";
import { runId } from "../lib/run-id";

/**
 * Logo upload (K1), through the real server: the sub-account Branding card
 * resizes a file in the browser and uploads it; the logo is then served
 * signed-out from /api/brand/logo/sa/{id} as the stored PNG/WebP with
 * nosniff, inline, a sandboxing CSP, and an immutable cache only for the
 * current version. An SVG picked in the browser is rasterised before
 * upload, so only PNG bytes reach the server; SVG / HTML posted straight at
 * the route, and an oversize body, are refused. Remove clears the field and the logo 404s.
 *
 * Writes only the fixture PRIMARY's `logoUrl` and its
 * `private/brandLogo` doc; both are read before the first write and put back
 * afterwards.
 */

const env = readEnv();
const sa = env.E2E_SUBACCOUNT_ID;
const guard = () => assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
const subRef = () => adminDb().doc(`subAccounts/${sa}`);
const logoRef = () => adminDb().doc(`subAccounts/${sa}/private/brandLogo`);
const settings = `/sa/${sa}/dashboard/settings`;
const uploadPath = `/api/sub-accounts/${sa}/logo`;

/** What setup read BEFORE writing — set only once it has (teardown runs even when setup throws). */
let prior: { logoUrl: unknown; logoDoc: FirebaseFirestore.DocumentData | undefined } | null = null;

test.beforeAll(async () => {
  await guard();
  const [sub, logo] = await Promise.all([subRef().get(), logoRef().get()]);
  prior = { logoUrl: sub.data()?.logoUrl, logoDoc: logo.exists ? logo.data() : undefined };
});

test.afterAll(async () => {
  await guard(); // never touch a doc the guard did not clear
  const p = prior;
  if (!p) return;
  await subRef().update({ logoUrl: p.logoUrl === undefined ? FieldValue.delete() : p.logoUrl });
  if (p.logoDoc) await logoRef().set(p.logoDoc);
  else await logoRef().delete();
});

async function openBranding(page: Page) {
  await page.goto(settings);
  const form = page.locator("form", { has: page.locator("#sa-logo-url") });
  // Hydrated once Save enables; an earlier upload would race the hydration.
  await expect(form.getByRole("button", { name: "Save" })).toBeEnabled({ timeout: 30_000 });
  return form;
}

async function uploadThroughCard(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const form = await openBranding(page);
  await form.locator("input[type=file]").setInputFiles(file);
  await expect(page.getByText("Logo uploaded.")).toBeVisible({ timeout: 30_000 });
  const logoUrl = await form.locator("#sa-logo-url").inputValue();
  expect(logoUrl).toMatch(new RegExp(`/api/brand/logo/sa/${sa}\\?v=\\d+$`));
  expect((await subRef().get()).data()?.logoUrl).toBe(logoUrl);
  return logoUrl;
}

/** Fetched as an email client would: no session. */
async function fetchSignedOut(browser: Browser, path: string) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const res = await context.request.get(path, { maxRedirects: 0 });
    return { status: res.status(), headers: res.headers(), body: await res.body() };
  } finally {
    await context.close();
  }
}

const pathOf = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

test("a PNG uploaded on the Branding card is served signed-out with safe headers", async ({ page, browser }) => {
  const png = await sharp({
    create: { width: 1600, height: 400, channels: 4, background: { r: 30, g: 90, b: 200, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const logoUrl = await uploadThroughCard(page, { name: `logo-${runId()}.png`, mimeType: "image/png", buffer: png });

  const stored = (await logoRef().get()).data() as { mime: string; data: string; version: number };
  expect(["image/png", "image/webp"]).toContain(stored.mime);
  // The browser resized it under the 512px edge before it left the page.
  const meta = await sharp(Buffer.from(stored.data, "base64")).metadata();
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(512);

  const res = await fetchSignedOut(browser, pathOf(logoUrl));
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toBe(stored.mime);
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
  expect(res.headers["content-disposition"]).toBe("inline");
  expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
  expect(res.headers["cache-control"]).toContain("immutable");
  expect(res.body.equals(Buffer.from(stored.data, "base64"))).toBe(true);

  // Any other version is served, but never pinned.
  const stale = await fetchSignedOut(browser, `/api/brand/logo/sa/${sa}?v=1`);
  expect(stale.status).toBe(200);
  expect(stale.headers["cache-control"]).not.toContain("immutable");
});

test("an SVG picked in the browser is rasterised; only PNG/WebP bytes are stored", async ({ page, browser }) => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#c00"/></svg>',
  );
  const logoUrl = await uploadThroughCard(page, { name: `logo-${runId()}.svg`, mimeType: "image/svg+xml", buffer: svg });
  const stored = (await logoRef().get()).data() as { mime: string; data: string };
  expect(["image/png", "image/webp"]).toContain(stored.mime);
  expect(Buffer.from(stored.data, "base64").toString("latin1")).not.toContain("<svg");
  const res = await fetchSignedOut(browser, pathOf(logoUrl));
  expect(res.headers["content-type"]).not.toContain("svg");
});

test("the upload route refuses SVG, HTML, a polyglot and an oversize body", async ({ page }) => {
  await openBranding(page);
  const before = (await logoRef().get()).data();
  const post = (body: unknown) => pageFetch(page, uploadPath, "POST", JSON.stringify(body));
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString("base64");
  const html = Buffer.from("<!doctype html><script>alert(1)</script>").toString("base64");
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer();
  const polyglot = Buffer.concat([png, Buffer.from("<script>alert(1)</script>")]).toString("base64");

  expect((await post({ data: svg, mime: "image/svg+xml" })).status).toBe(400);
  expect((await post({ data: svg, mime: "image/png" })).status).toBe(400);
  expect((await post({ data: html, mime: "image/png" })).status).toBe(400);
  expect((await post({ data: polyglot, mime: "image/png" })).status).toBe(400);
  const big = await page.evaluate(
    async ({ url }) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: "A".repeat(700_000), mime: "image/png" }) })).status,
    { url: uploadPath },
  );
  expect(big).toBe(413);
  // Nothing refused reached storage.
  expect((await logoRef().get()).data()).toEqual(before);
});

test("a bad or unknown id 404s; Remove clears the logo and it stops being served", async ({ page, browser }) => {
  expect((await fetchSignedOut(browser, `/api/brand/logo/sa/__e2e__`)).status).toBe(404);
  expect((await fetchSignedOut(browser, `/api/brand/logo/sa/e2e-missing-${runId()}`)).status).toBe(404);

  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#0a0" } }).png().toBuffer();
  const logoUrl = await uploadThroughCard(page, { name: `logo-${runId()}.png`, mimeType: "image/png", buffer: png });
  const form = page.locator("form", { has: page.locator("#sa-logo-url") });
  await form.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Logo removed.")).toBeVisible({ timeout: 30_000 });
  await expect(form.locator("#sa-logo-url")).toHaveValue("");
  expect((await subRef().get()).data()?.logoUrl ?? null).toBeNull();
  expect((await fetchSignedOut(browser, pathOf(logoUrl))).status).toBe(404);
});
