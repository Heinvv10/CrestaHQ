import { expect, test, type Page } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount } from "../lib/guard";
import type { BillingPlanDoc } from "@/types/billing";
import type { SubAccountBilling } from "@/types/billing";

/**
 * SP13 (e) — agency Client Billing → "Reselling overview" (DISPLAY ONLY,
 * see src/lib/billing/reselling.ts and src/components/agency/reselling-table.tsx).
 * Seeds one plan doc directly (bypassing Stripe — stripe ids null, the
 * billing page must not try to call Stripe to RENDER a plan) and puts the
 * fixture PRIMARY sub-account on it as an active subscriber, then flips it
 * to past_due and confirms the table's counts move with it. A third test
 * archives the plan itself and confirms its still-subscribed row stays
 * visible (marked Archived) and counted in the totals, rather than
 * disappearing along with the rest of the archived plans.
 */

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);
const agencyId = () => readEnv().E2E_AGENCY_ID;

const stamp = Date.now();
const planId = `e2e-resell-${stamp}`;
const planRef = () => adminDb().doc(`agencies/${agencyId()}/plans/${planId}`);

const PLAN_PRICE_CENTS = 49900; // R 499.00

function planDoc(): Omit<BillingPlanDoc, "createdAt" | "updatedAt"> & {
  createdAt: FieldValue;
  updatedAt: FieldValue;
} {
  return {
    id: planId,
    agencyId: agencyId(),
    name: `E2E Resell ${stamp}`,
    description: null,
    priceMonthlyCents: PLAN_PRICE_CENTS,
    priceAnnualCents: null,
    currency: "zar",
    gates: {
      emailDomainEnabledByAgency: false,
      apiAccessEnabledByAgency: false,
      broadcastsEnabledByAgency: true,
      outboundVoiceEnabledByAgency: false,
      whatsappEnabledByAgency: true,
      smsAgentEnabledByAgency: false,
      webChatEnabledByAgency: false,
      inboundVoiceEnabledByAgency: false,
      metaInboxEnabledByAgency: false,
      metaAgentEnabledByAgency: false,
      websiteEnabledByAgency: false,
      socialPlannerEnabledByAgency: false,
      communityEnabledByAgency: false,
      missedCallTextBackEnabledByAgency: false,
      aiSuiteEnabledByAgency: false,
      labsEnabledByAgency: false,
      reviewsAiEnabledByAgency: false,
    },
    status: "active",
    stripeProductId: null,
    stripePriceId: null,
    stripeAnnualPriceId: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function activeBilling(): SubAccountBilling {
  return {
    status: "active",
    planId,
    planName: `E2E Resell ${stamp}`,
    priceCents: PLAN_PRICE_CENTS,
    billingInterval: "month",
    currency: "zar",
    specialPriceCents: null,
    stripePriceId: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    checkoutTokenHash: null,
    graceUntil: null,
    assignedAt: FieldValue.serverTimestamp() as unknown as SubAccountBilling["assignedAt"],
    activatedAt: FieldValue.serverTimestamp() as unknown as SubAccountBilling["activatedAt"],
    updatedAt: FieldValue.serverTimestamp() as unknown as SubAccountBilling["updatedAt"],
  };
}

/** What setup read BEFORE writing — restored in afterAll, never a guessed value. */
let priorBilling: unknown;
let priorBillingRead = false;

test.beforeAll(async () => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  const snap = await primaryRef().get();
  priorBilling = snap.data()?.billing;
  priorBillingRead = true;

  await planRef().set(planDoc());
  await primaryRef().update({ billing: activeBilling() });
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
  if (priorBillingRead) {
    await step(() =>
      primaryRef().update({
        billing: priorBilling === undefined ? FieldValue.delete() : priorBilling,
      }),
    );
  }
  // Guard: only ever delete the plan doc we created this run, under the
  // fixture agency, with the id prefix this spec mints.
  await step(async () => {
    if (!planId.startsWith("e2e-resell-")) {
      throw new Error(`refusing to delete non-fixture plan id ${planId}`);
    }
    const snap = await planRef().get();
    if (!snap.exists) return;
    if (snap.data()?.agencyId !== agencyId()) {
      throw new Error(
        `plan ${planId} belongs to agency ${String(snap.data()?.agencyId)}, not the fixture agency; refusing to delete`,
      );
    }
    await adminDb().recursiveDelete(planRef());
  });
  if (errors.length > 0) throw errors[0];
});

async function gotoBilling(page: Page) {
  await page.goto("/agency/billing");
  await expect(page.getByTestId("reselling-table")).toBeVisible({ timeout: 15_000 });
}

test("shows the seeded plan as an active subscriber with MRR, and the ZAR total includes it", async ({ page }) => {
  await gotoBilling(page);

  const row = page.locator(`[data-testid="reselling-row"][data-plan-id="${planId}"]`);
  await expect(row).toBeVisible();

  const subscribers = row.getByTestId("reselling-subscribers");
  await expect(subscribers).toHaveAttribute("data-active", "1");
  await expect(subscribers).toContainText("1 active");

  const mrr = row.getByTestId("reselling-mrr");
  await expect(mrr).toContainText("R"); // ZAR formatted price, e.g. "R 499.00"
  await expect(mrr).toContainText("499");

  const total = page.locator('[data-testid="reselling-total"][data-currency="zar"]');
  await expect(total).toBeVisible();
  await expect(total).toContainText("499");

  // The plan has null Stripe ids — the page must render it without erroring
  // or attempting a Stripe call (a thrown client error would blank the
  // section; asserting it's still visible is the proof).
  await expect(page.getByTestId("reselling-table")).toBeVisible();
});

test("moving the subscriber to past_due drops the active count to zero", async ({ page }) => {
  await primaryRef().update({
    "billing.status": "past_due",
    "billing.graceUntil": new Date(Date.now() + 3 * 86_400_000),
  });

  await gotoBilling(page);

  const row = page.locator(`[data-testid="reselling-row"][data-plan-id="${planId}"]`);
  const subscribers = row.getByTestId("reselling-subscribers");
  await expect(subscribers).toHaveAttribute("data-active", "0");
  await expect(subscribers).toContainText("0 active");
  // The past-due count renders beside the active count, not inside it.
  await expect(row).toContainText("1 past due");
});

test("archiving the plan keeps its row (marked Archived) and its subscriber in the total, since it still has one", async ({ page }) => {
  // Bring the subscriber back to active, then archive the plan itself —
  // archiving stops new assignments but must not drop an existing
  // subscriber's MRR off the table (PR #155 review finding).
  await primaryRef().update({
    "billing.status": "active",
    "billing.graceUntil": null,
  });
  await planRef().update({ status: "archived" });

  await gotoBilling(page);

  const row = page.locator(`[data-testid="reselling-row"][data-plan-id="${planId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-archived", "true");
  await expect(row).toContainText("Archived");

  const subscribers = row.getByTestId("reselling-subscribers");
  await expect(subscribers).toHaveAttribute("data-active", "1");

  const total = page.locator('[data-testid="reselling-total"][data-currency="zar"]');
  await expect(total).toContainText("499");
});
