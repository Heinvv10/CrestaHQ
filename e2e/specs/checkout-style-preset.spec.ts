import { expect, test, type Browser, type Page } from "@playwright/test";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { pageFetch } from "../lib/gbp";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { runId } from "../lib/run-id";

/**
 * Style presets on the public checkout page (/co), through the real server:
 * a page saved before presets keeps its original look, a preset restyles it,
 * the editor's picker is what writes the field, and an unknown preset is
 * refused by the route and harmless when already stored.
 *
 * Pages and products are this run's own, under a run-scoped prefix on the
 * fixture PRIMARY, written published with the Admin SDK (publishing through
 * the app needs a connected Stripe account, which the fixture has none of).
 * Nothing is paid: no test presses Pay. /co needs the Payments gate, so it is
 * switched on for the run and put back afterwards.
 */

test.use({ locale: "en-US", colorScheme: "light" });

const BASE_PREFIX = "e2e-costyle-";
const PREFIX = `${BASE_PREFIX}${runId()}-`;
const STALE_MS = 6 * 3600_000;

const env = readEnv();
const sa = env.E2E_SUBACCOUNT_ID;
const stamp = Date.now();
const guard = () => assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
const subRef = () => adminDb().doc(`subAccounts/${sa}`);
const pages = () => adminDb().collection(`subAccounts/${sa}/checkoutPages`);
const MAIN = `${PREFIX}main`;
const BUMP = `${PREFIX}bump`;
const tenancy = { agencyId: env.E2E_AGENCY_ID, subAccountId: sa, createdByUid: "e2e" };
const stampNow = () => ({ createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });

async function seedProducts() {
  const product = { ...tenancy, description: "", currency: "USD", active: true };
  await adminDb().doc(`products/${MAIN}`).set({ ...product, name: "E2E Style Offer", unitPriceCents: 4900, ...stampNow() });
  await adminDb()
    .doc(`products/${BUMP}`)
    .set({ ...product, name: "E2E Style Bump", unitPriceCents: 1900, bumpEligible: true, bumpHeadline: "Add the workbook", ...stampNow() });
}

/** A published page; `over` is how a preset (or none) is stored on it. */
async function seedPage(key: string, over: Record<string, unknown> = {}): Promise<{ id: string; slug: string; name: string }> {
  const id = `${PREFIX}${key}-${stamp}`;
  const name = `E2E Style ${key} ${stamp}`;
  await pages()
    .doc(id)
    .set({
      ...tenancy,
      slug: id,
      name,
      status: "published",
      productId: MAIN,
      bumpProductIds: [BUMP],
      headline: name,
      subheadline: "A fixture offer.",
      collectFields: [],
      autoTags: [],
      pipelineStageId: null,
      successUrl: null,
      appearance: { theme: "light", accent: "#7c3aed", hideChrome: false, hideTitle: false },
      ...stampNow(),
      ...over,
    });
  return { id, slug: id, name };
}

/** This run's docs, plus any an earlier crashed run left behind (by age, so
 *  a concurrent run's live docs are never touched). */
async function purge() {
  const mine = (id: string, createdAt: unknown) =>
    id.startsWith(PREFIX) ||
    (id.startsWith(BASE_PREFIX) && createdAt instanceof Timestamp && Date.now() - createdAt.toMillis() > STALE_MS);
  for (const d of (await pages().get()).docs) {
    if (mine(d.id, d.data().createdAt)) await deleteScoped(d.ref);
  }
  const products = await adminDb().collection("products").where("subAccountId", "==", sa).get();
  for (const d of products.docs) {
    if (mine(d.id, d.data().createdAt)) await deleteScoped(d.ref);
  }
}

/** The public page as a signed-out buyer sees it. */
async function visit(browser: Browser, p: { slug: string; name: string }, check: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, colorScheme: "light" });
  try {
    const page = await context.newPage();
    const res = await page.goto(`/co/${sa}/${p.slug}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: p.name })).toBeVisible({ timeout: 30_000 });
    await check(page);
  } finally {
    await context.close();
  }
}

const pay = (page: Page) => page.getByRole("button", { name: "Pay $49.00" });
const bump = (page: Page) => page.locator("label", { hasText: "E2E Style Bump" });

/** The look every checkout page had before presets existed. */
async function expectOriginalLook(page: Page) {
  await expect(page.locator("main")).toHaveCSS("background-color", "rgb(250, 250, 250)");
  await expect(pay(page)).toHaveCSS("background-color", "rgb(124, 58, 237)");
  await expect(pay(page)).toHaveCSS("font-weight", "600");
  await expect(pay(page)).toHaveCSS("border-radius", "10px");
  await expect(pay(page)).toHaveCSS("text-transform", "none");
  await expect(bump(page)).toHaveCSS("border-radius", "10px");
  expect(await bump(page).locator("input[type=checkbox]").getAttribute("style")).not.toContain("accent-color");
}

/** What setup read BEFORE writing — set only once it has (teardown runs even when setup throws). */
let priorGate: { value: unknown } | null = null;

test.beforeAll(async () => {
  await guard();
  await purge();
  const before = (await subRef().get()).data() ?? {};
  priorGate = { value: before.paymentsEnabledByAgency };
  await subRef().update({ paymentsEnabledByAgency: true });
  await seedProducts();
});

test.afterAll(async () => {
  const errors: unknown[] = [];
  const step = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      errors.push(err);
    }
  };
  await step(guard);
  if (errors.length) throw errors[0]; // never touch a doc the guard did not clear
  await step(purge);
  const prior = priorGate;
  if (prior) {
    await step(() => subRef().update({ paymentsEnabledByAgency: prior.value === undefined ? FieldValue.delete() : prior.value }));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "checkout-style-preset teardown: several steps failed");
});

test("a page saved before presets keeps its original look", async ({ browser }) => {
  await visit(browser, await seedPage("legacy"), expectOriginalLook);
});

test("a preset restyles the public page and its form, content unchanged", async ({ browser }) => {
  await visit(browser, await seedPage("noir", { themePreset: "noir-lime" }), async (page) => {
    await expect(page.locator("main")).toHaveCSS("background-color", "rgb(5, 5, 5)");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("text-transform", "uppercase");
    await expect(pay(page)).toHaveCSS("background-color", "rgb(204, 255, 0)");
    await expect(pay(page)).toHaveCSS("color", "rgb(10, 10, 10)");
    await expect(pay(page)).toHaveCSS("font-weight", "700");
    await expect(pay(page)).toHaveCSS("border-radius", "2px");
    await expect(pay(page)).toHaveCSS("text-transform", "uppercase");
    await expect(bump(page)).toHaveCSS("border-radius", "2px");
    expect(await bump(page).locator("input[type=checkbox]").getAttribute("style")).toContain("accent-color");
    await expect(page.getByText("A fixture offer.")).toBeVisible();
    await expect(bump(page)).toContainText("+ $19.00");
  });
});

test("a stored preset this build does not know renders the original look", async ({ browser }) => {
  await visit(browser, await seedPage("unknown", { themePreset: "no-such-preset" }), expectOriginalLook);
});

test("the editor's Style picker saves the preset; an untouched save leaves an old page as it was", async ({ page, browser }) => {
  const p = await seedPage("edit");
  const stored = async () => (await pages().doc(p.id).get()).data() ?? {};
  const openEditor = async () => {
    await page.goto(`/sa/${sa}/checkout`);
    const row = page.locator("div.rounded-xl", { hasText: p.name });
    await row.getByRole("button", { name: "Edit" }).click({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Edit checkout page" })).toBeVisible();
  };
  const save = async () => {
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("heading", { name: "Edit checkout page" })).toHaveCount(0, { timeout: 30_000 });
  };

  // Saving another field of a pre-preset page stores no preset.
  await openEditor();
  await expect(page.getByRole("button", { name: /^Brand default/ })).toHaveAttribute("aria-pressed", "true");
  await page.locator("#co-headline").fill(`${p.name} edited`);
  await save();
  await expect.poll(async () => (await stored()).headline, { timeout: 30_000 }).toBe(`${p.name} edited`);
  expect((await stored()).themePreset ?? null).toBeNull();
  await visit(browser, { slug: p.slug, name: `${p.name} edited` }, expectOriginalLook);

  // Picking a preset stores it, and the public page takes it.
  await openEditor();
  const sunset = page.getByRole("button", { name: /^Sunset/ });
  await sunset.click();
  await expect(sunset).toHaveAttribute("aria-pressed", "true");
  await save();
  await expect.poll(async () => (await stored()).themePreset, { timeout: 30_000 }).toBe("sunset");
  await visit(browser, { slug: p.slug, name: `${p.name} edited` }, async (pub) => {
    await expect(pub.locator("main")).toHaveCSS("background-color", "rgb(253, 246, 236)");
    await expect(pay(pub)).toHaveCSS("background-color", "rgb(234, 88, 12)");
  });
});

test("the route refuses an unknown preset and leaves the page as it was", async ({ page }) => {
  const p = await seedPage("api", { themePreset: "ocean" });
  const stored = async () => (await pages().doc(p.id).get()).data()?.themePreset;

  // From inside the signed-in page: its session cookie is what authorises this.
  await page.goto(`/sa/${sa}/checkout`);
  await expect(page.getByText(p.name)).toBeVisible({ timeout: 30_000 });
  const url = `/api/sub-accounts/${sa}/checkout-pages/${p.id}`;

  const bad = await pageFetch(page, url, "PATCH", JSON.stringify({ themePreset: "no-such-preset" }));
  expect(bad).toEqual({ status: 400, body: { error: "Unknown style preset." } });
  expect(await stored()).toBe("ocean");

  const good = await pageFetch(page, url, "PATCH", JSON.stringify({ themePreset: "midnight" }));
  expect(good.status).toBe(200);
  expect(await stored()).toBe("midnight");
});
