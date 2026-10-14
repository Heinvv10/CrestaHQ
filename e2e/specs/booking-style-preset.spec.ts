import { createHash, createHmac, randomBytes } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { pageFetch } from "../lib/gbp";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { runId } from "../lib/run-id";

/**
 * Style presets on the public booking page (/b), through the real server and
 * the real stylesheet: a page with no preset keeps the standard look, a
 * preset restyles it (the CSS variables set on <main> actually reach the
 * card), the editor's picker is what writes the field, an unknown preset is
 * refused by the route and harmless when already stored, and a stored accent
 * that is not a hex colour is ignored.
 *
 * Pages are this run's own, under a run-scoped slug prefix on the fixture
 * PRIMARY; nothing is booked (the one event, for /e, is written directly). The visitor's colour scheme is pinned to light
 * so "standard look" means one thing.
 */

test.use({ timezoneId: "UTC", locale: "en-US", colorScheme: "light" });

const BASE_PREFIX = "e2e-style-";
const PREFIX = `${BASE_PREFIX}${runId()}-`;
const STALE_MS = 6 * 3600_000;

const env = readEnv();
const sa = env.E2E_SUBACCOUNT_ID;
// Short: a booking slug is at most 48 characters.
const stamp = Date.now().toString(36);
const guard = () => assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
const pageRef = (slug: string) => adminDb().doc(`subAccounts/${sa}/bookingPages/${slug}`);

async function seedPage(slug: string, over: Record<string, unknown> = {}) {
  await pageRef(slug).set({
    id: slug,
    slug,
    name: `E2E Style ${slug}`,
    description: "",
    status: "published",
    durationMinutes: 30,
    bufferMinutes: 0,
    workingHours: [{ dayOfWeek: 1, startMinute: 1260, endMinute: 1440 }],
    timezone: "UTC",
    visibleDays: 2,
    minNoticeHours: 0,
    maxPerDay: null,
    intakeFields: [],
    logoUrl: null,
    accentColor: null,
    meetingUrl: null,
    confirmationMessage: "",
    remindersEnabled: false,
    reminderOffsetsMinutes: [],
    payment: null,
    territoryId: "global",
    defaultTerritoryId: null,
    agencyId: env.E2E_AGENCY_ID,
    subAccountId: sa,
    createdByUid: "e2e",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...over,
  });
}

/**
 * An event on `slug` and its /e manage token, written directly so nothing is
 * booked. The token is signed as src/lib/booking/event-token.ts signs it
 * (that module is server-only), with the secret the app under test reads.
 */
async function seedEvent(slug: string, over: Record<string, unknown>, secret: string): Promise<string> {
  const id = `${PREFIX}ev-${stamp}`;
  const payload = `${id}.${randomBytes(16).toString("hex")}`;
  const token = `${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const start = new Date(Date.now() + 7 * 86_400_000);
  await adminDb().doc(`events/${id}`).set({
    title: `E2E Style event ${stamp}`,
    status: "scheduled",
    source: "booking_page",
    bookingPageSlug: slug,
    publicTokenHash: createHash("sha256").update(token).digest("hex"),
    startAt: Timestamp.fromDate(start),
    endAt: Timestamp.fromDate(new Date(start.getTime() + 30 * 60_000)),
    agencyId: env.E2E_AGENCY_ID,
    subAccountId: sa,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...over,
  });
  return token;
}

/** This run's pages and events, plus any an earlier crashed run left behind
 *  (by age, so a concurrent run's live docs are never touched). */
async function purge() {
  const events = await adminDb().collection("events").where("subAccountId", "==", sa).get();
  for (const d of events.docs) {
    const createdAt = d.data().createdAt;
    const stale = createdAt instanceof Timestamp && Date.now() - createdAt.toMillis() > STALE_MS;
    if (d.id.startsWith(PREFIX) || (d.id.startsWith(BASE_PREFIX) && stale)) await deleteScoped(d.ref);
  }
  const pages = await adminDb().collection(`subAccounts/${sa}/bookingPages`).get();
  for (const d of pages.docs) {
    const createdAt = d.data().createdAt;
    const stale = createdAt instanceof Timestamp && Date.now() - createdAt.toMillis() > STALE_MS;
    if (d.id.startsWith(PREFIX) || (d.id.startsWith(BASE_PREFIX) && stale)) await deleteScoped(d.ref);
  }
}

/** The public page as a signed-out visitor sees it, in a light or dark OS theme. */
async function visit(browser: Browser, slug: string, check: (page: Page) => Promise<void>, colorScheme: "light" | "dark" = "light") {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, colorScheme, timezoneId: "UTC" });
  try {
    const page = await context.newPage();
    const res = await page.goto(`/b/${sa}/${slug}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: `E2E Style ${slug}` })).toBeVisible({ timeout: 30_000 });
    await check(page);
  } finally {
    await context.close();
  }
}

async function expectStandardLook(page: Page) {
  const main = page.locator("main");
  expect(await main.getAttribute("style")).toBeNull();
  await expect(main).not.toHaveClass(/(^|\s)dark(\s|$)/);
  expect(await page.locator("article").getAttribute("style")).toBeNull();
  expect(await page.getByRole("heading", { level: 1 }).getAttribute("style")).toBeNull();
}

test.beforeAll(async () => {
  await guard();
  await purge();
});

test.afterEach(async () => {
  await guard();
  await purge();
});

test("a page with no preset keeps the standard look", async ({ browser }) => {
  const slug = `${PREFIX}plain-${stamp}`;
  await seedPage(slug);
  await visit(browser, slug, expectStandardLook);
});

test("a preset restyles the public page from the preset alone", async ({ browser }) => {
  const slug = `${PREFIX}noir-${stamp}`;
  await seedPage(slug, { themePreset: "noir-lime" });
  await visit(browser, slug, async (page) => {
    const main = page.locator("main");
    await expect(main).toHaveCSS("background-color", "rgb(5, 5, 5)");
    await expect(main).toHaveClass(/(^|\s)dark(\s|$)/);
    // The card and the timezone list take the preset through the CSS
    // variables on <main>, not through anything set on themselves.
    const article = page.locator("article");
    await expect(article).toHaveCSS("background-color", "rgb(15, 15, 16)");
    await expect(article).toHaveCSS("border-radius", "4px");
    await expect(page.locator("select").first()).toHaveCSS("background-color", "rgb(22, 22, 23)");
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveCSS("text-transform", "uppercase");
    await expect(h1).toHaveCSS("color", "rgb(245, 245, 244)");
  });
});

test("a dark-mode visitor on a light preset gets the light status colour, with no dark: variant", async ({ browser }) => {
  const slug = `${PREFIX}osdark-${stamp}`;
  await seedPage(slug, { themePreset: "sunset", payment: { amount: 50, currency: "USD", description: null, holdHours: 24 } });
  await visit(
    browser,
    slug,
    async (page) => {
      // The visitor really is in dark mode: the app marks <html> for it.
      await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
      const main = page.locator("main");
      await expect(main).toHaveClass(/(^|\s)light(\s|$)/);
      await expect(main).toHaveCSS("background-color", "rgb(253, 246, 236)");
      await expect(page.locator("article")).toHaveCSS("background-color", "rgb(255, 253, 248)");
      const chip = page.getByText("USD 50 deposit");
      await expect(chip).toHaveClass(/(^|\s)text-emerald-700(\s|$)/);
      await expect(chip).not.toHaveClass(/dark:/);
      expect(await main.evaluate((el) => el.outerHTML)).not.toContain("dark:");
    },
    "dark",
  );
});

test("a stored preset this build does not know renders the standard look", async ({ browser }) => {
  const slug = `${PREFIX}unknown-${stamp}`;
  await seedPage(slug, { themePreset: "no-such-preset" });
  await visit(browser, slug, async (page) => {
    await expectStandardLook(page);
    expect(await page.content()).not.toContain("no-such-preset");
    expect(await (await page.request.get(`/b/${sa}/${slug}`)).text()).not.toContain("no-such-preset");
  });
});

test("a stored accent that is not a hex colour never reaches the page", async ({ browser }) => {
  const slug = `${PREFIX}accent-${stamp}`;
  await seedPage(slug, { accentColor: "red;position:fixed;inset:0;background:url(https://evil.example/x)" });
  await visit(browser, slug, async (page) => {
    expect(await page.content()).not.toContain("evil.example");
    await expectStandardLook(page);
    // The raw responses too, where the props sent for hydration live.
    for (const path of [`/b/${sa}/${slug}`, `/embed/booking/${sa}/${slug}`]) {
      const res = await page.request.get(path);
      expect(res.status(), path).toBe(200);
      expect(await res.text(), path).not.toContain("evil.example");
    }
  });
});

test("the served page carries none of the stored doc's private fields", async ({ browser }) => {
  const slug = `${PREFIX}private-${stamp}`;
  const meetingUrl = `https://meet.example/sentinel-room-${stamp}`;
  const creator = `uid-sentinel-${stamp}`;
  await seedPage(slug, {
    meetingUrl,
    createdByUid: creator,
    confirmationMessage: `sentinel-message-${stamp}`,
    redirectUrl: `https://example.com/sentinel-thanks-${stamp}`,
  });
  const paths = [`/b/${sa}/${slug}`, `/embed/booking/${sa}/${slug}`];
  const eventSecret = process.env.AUTOMATIONS_TOKEN_SECRET;
  if (eventSecret) {
    // PR CI starts the app with this job's short-lived key, so it can also
    // prove /e. Production uses a different secret that is deliberately not
    // copied into Actions; its smoke still proves the two public page shapes.
    const token = await seedEvent(slug, { meetingUrl, createdByUid: creator }, eventSecret);
    paths.push(`/e/${token}`);
  }
  await visit(browser, slug, async (page) => {
    // The raw responses: what Next inlines for hydration is in here, rendered or not.
    for (const path of paths) {
      const res = await page.request.get(path);
      expect(res.status(), path).toBe(200);
      const body = await res.text();
      for (const secret of [meetingUrl, creator, `sentinel-message-${stamp}`, `sentinel-thanks-${stamp}`, env.E2E_AGENCY_ID, "meetingUrl", "createdByUid"]) {
        expect(body, `${path} must not contain ${secret}`).not.toContain(secret);
      }
      // It is the page we think it is.
      expect(body, path).toContain(`E2E Style ${slug}`);
    }
  });
});

test("the editor's Style picker saves the preset, and Brand default clears it", async ({ page, browser }) => {
  const slug = `${PREFIX}edit-${stamp}`;
  await seedPage(slug);
  const stored = async () => (await pageRef(slug).get()).data()?.themePreset ?? null;

  await page.goto(`/sa/${sa}/booking/${slug}`);
  const none = page.getByRole("button", { name: /^Brand default/ });
  const ocean = page.getByRole("button", { name: /^Ocean/ });
  await expect(none).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });

  await ocean.click();
  await expect(ocean).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(stored, { timeout: 30_000 }).toBe("ocean");
  await visit(browser, slug, async (pub) => {
    await expect(pub.locator("main")).toHaveCSS("background-color", "rgb(242, 247, 250)");
    await expect(pub.locator("article")).toHaveCSS("border-radius", "14px");
  });

  await none.click();
  await expect(none).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(stored, { timeout: 30_000 }).toBeNull();
  await visit(browser, slug, expectStandardLook);
});

test("the route refuses an unknown preset and leaves the page as it was", async ({ page }) => {
  const slug = `${PREFIX}api-${stamp}`;
  await seedPage(slug, { themePreset: "sunset" });
  const { createdAt: _c, updatedAt: _u, ...form } = (await pageRef(slug).get()).data() ?? {};

  // From inside the signed-in page: its session cookie is what authorises this.
  await page.goto(`/sa/${sa}/booking/${slug}`);
  await expect(page.getByRole("button", { name: /^Sunset/ })).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  const url = `/api/sub-accounts/${sa}/booking-pages/${slug}`;

  const bad = await pageFetch(page, url, "PATCH", JSON.stringify({ ...form, themePreset: "no-such-preset" }));
  expect(bad).toEqual({ status: 400, body: { error: "Unknown style preset." } });
  expect((await pageRef(slug).get()).data()?.themePreset).toBe("sunset");

  const good = await pageFetch(page, url, "PATCH", JSON.stringify({ ...form, themePreset: "midnight" }));
  expect(good.status).toBe(200);
  expect((await pageRef(slug).get()).data()?.themePreset).toBe("midnight");
});
