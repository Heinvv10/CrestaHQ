import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { runId } from "../lib/run-id";

/**
 * Express buy links (/co/[sa]/buy/[slug], upstream 1.0.54 F2) through the
 * real server: an on-sale product renders, a product whose sale belongs to a
 * published checkout page is redirected there and its session is refused
 * with nothing written, and the thanks page shows an order only to the
 * holder of its token.
 *
 * Nothing reaches Stripe: no test presses the buy button, and the one session
 * request is refused before any provider call. Selling needs the agency gate,
 * Payments, a ready rail and email, so the run switches those on for the
 * fixture PRIMARY (rail and email as display metadata only: no Stripe key or
 * SMTP password is written) and puts each field back afterwards. Products,
 * pages and orders are this run's own, under a run-scoped prefix.
 */

test.use({ locale: "en-US", colorScheme: "light" });

const BASE_PREFIX = "e2e-buy-";
const PREFIX = `${BASE_PREFIX}${runId()}-`;
const STALE_MS = 6 * 3600_000;

const env = readEnv();
const sa = env.E2E_SUBACCOUNT_ID;
const guard = () => assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
const subRef = () => adminDb().doc(`subAccounts/${sa}`);
const pages = () => adminDb().collection(`subAccounts/${sa}/checkoutPages`);
const tenancy = { agencyId: env.E2E_AGENCY_ID, subAccountId: sa, createdByUid: "e2e" };
const stampNow = () => ({ createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });

const SOLD = `${PREFIX}sold`;
const LINKED = `${PREFIX}linked`;
const PAGE = `${PREFIX}page`;
const ORDER = `${PREFIX}order`;
const slugOf = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60).replace(/-+$/, "");
const TOKEN = "e2e".padEnd(43, "x");

const GATE_FIELDS = [
  "sellOnlineEnabledByAgency",
  "paymentsEnabledByAgency",
  "stripeConnectionMeta",
  "emailProvider",
  "smtpConfig",
] as const;

async function seed() {
  const product = { ...tenancy, description: "", currency: "USD", active: true, sellOnline: true, ...stampNow() };
  await adminDb().doc(`products/${SOLD}`).set({ ...product, name: "E2E Buy Guide", unitPriceCents: 4900, slug: slugOf(SOLD) });
  await adminDb()
    .doc(`products/${LINKED}`)
    .set({ ...product, name: "E2E Buy Linked", unitPriceCents: 2900, slug: slugOf(LINKED), checkoutPageId: PAGE });
  await pages()
    .doc(PAGE)
    .set({
      ...tenancy,
      slug: slugOf(PAGE),
      name: "E2E Buy Page",
      status: "published",
      productId: LINKED,
      bumpProductIds: [],
      headline: "E2E Buy Page",
      subheadline: "",
      collectFields: [],
      autoTags: [],
      pipelineStageId: null,
      successUrl: null,
      ...stampNow(),
    });
  await adminDb()
    .doc(`orders/${ORDER}`)
    .set({
      ...tenancy,
      contactId: null,
      checkoutPageId: null,
      quoteId: null,
      eventId: null,
      communityGroupId: null,
      purchaseId: null,
      source: "product_link",
      status: "paid",
      currency: "usd",
      lineItems: [{ productId: SOLD, name: "E2E Buy Guide", description: "", unitPriceCents: 4900, quantity: 1, isBump: false }],
      subtotalCents: 4900,
      totalCents: 4900,
      refundedCents: 0,
      stripeCheckoutSessionId: `cs_test_${PREFIX}`,
      stripePaymentIntentId: null,
      livemode: false,
      buyerEmail: "e2e-buyer@example.com",
      buyerName: null,
      attribution: null,
      productLinkProductId: SOLD,
      thanksTokenHash: createHash("sha256").update(TOKEN).digest("hex"),
      paidAt: null,
      ...stampNow(),
    });
}

/** This run's docs, plus any an earlier crashed run left behind (by age). */
async function purge() {
  const mine = (id: string, createdAt: unknown) =>
    id.startsWith(PREFIX) ||
    (id.startsWith(BASE_PREFIX) && createdAt instanceof Timestamp && Date.now() - createdAt.toMillis() > STALE_MS);
  for (const d of (await pages().get()).docs) {
    if (mine(d.id, d.data().createdAt)) await deleteScoped(d.ref);
  }
  for (const col of ["products", "orders"]) {
    const snap = await adminDb().collection(col).where("subAccountId", "==", sa).get();
    for (const d of snap.docs) {
      if (mine(d.id, d.data().createdAt)) await deleteScoped(d.ref);
    }
  }
}

/** What setup read BEFORE writing — set only once it has (teardown runs even when setup throws). */
let prior: Record<string, unknown> | null = null;

test.beforeAll(async () => {
  await guard();
  await purge();
  const before = (await subRef().get()).data() ?? {};
  prior = Object.fromEntries(GATE_FIELDS.map((k) => [k, before[k]]));
  await subRef().update({
    sellOnlineEnabledByAgency: true,
    paymentsEnabledByAgency: true,
    // A real connection's meta is kept; otherwise display-only meta with no
    // stored key, so a session would stop at the connection check.
    stripeConnectionMeta:
      (before.stripeConnectionMeta as { ready?: unknown } | undefined)?.ready === true
        ? before.stripeConnectionMeta
        : { mode: "key", ready: true, accountId: null, accountName: null, livemode: false, keyLast4: null, connectedAt: new Date() },
    ...(before.emailProvider === "smtp" && before.smtpConfig
      ? {}
      : {
          emailProvider: "smtp",
          smtpConfig: {
            host: "smtp.e2e.invalid",
            port: 587,
            secure: false,
            username: "e2e",
            fromEmail: "shop@e2e.invalid",
            fromName: "E2E Shop",
            verifiedAt: new Date().toISOString(),
          },
        }),
  });
  await seed();
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
  const was = prior;
  if (was) {
    await step(() =>
      subRef().update(
        Object.fromEntries(GATE_FIELDS.map((k) => [k, was[k] === undefined ? FieldValue.delete() : was[k]])),
      ),
    );
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "express-buy teardown: several steps failed");
});

test("an on-sale product renders its buy page", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    const res = await page.goto(`/co/${sa}/buy/${slugOf(SOLD)}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "E2E Buy Guide" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("$49.00")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to payment" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a sale owned by a published checkout page: the page redirects, the session is refused, nothing written", async ({ browser, request }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await page.goto(`/co/${sa}/buy/${slugOf(LINKED)}`);
    await expect(page).toHaveURL(new RegExp(`/co/${sa}/${slugOf(PAGE)}$`), { timeout: 30_000 });
  } finally {
    await context.close();
  }

  const refused = await request.post(`/api/co/${sa}/buy/${slugOf(LINKED)}/session`, {
    data: { unitPriceCents: 1 },
  });
  expect(refused.status()).toBe(409);
  const unknown = await request.post(`/api/co/${sa}/buy/${PREFIX}no-such-product/session`, { data: {} });
  expect(unknown.status()).toBe(404);
  const written = await adminDb().collection("orders").where("productLinkProductId", "==", LINKED).get();
  expect(written.size).toBe(0);
});

test("the thanks page shows the order only to the holder of its token", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    const path = `/co/${sa}/buy/${slugOf(SOLD)}/thanks?order=${ORDER}`;

    await page.goto(`${path}&t=${"y".repeat(43)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Thank you!" })).toBeVisible({ timeout: 30_000 });
    const html = await page.content();
    expect(html).not.toContain("E2E Buy Guide");
    expect(html).not.toContain("e2e-buyer@example.com");

    await page.goto(`${path}&t=${TOKEN}`);
    await expect(page.getByText("E2E Buy Guide")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("e2e-buyer@example.com")).toBeVisible();
  } finally {
    await context.close();
  }
});
