import { FieldValue } from "firebase-admin/firestore";
import { expect, test, type Page } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount } from "../lib/guard";

/**
 * AI Agents → Monitors (upstream 1.0.54 port, D1) through the real server on
 * the fixture PRIMARY. Each monitor keeps its own agency gate: the inbox
 * watchdog needs Labs, stale deals needs Agent monitors. Only the two gate
 * fields are written, and both are restored after.
 *
 * Read-only otherwise: nothing here saves a monitor, so no `customAgents`
 * doc is created and the hourly sweep never picks the fixture up.
 */

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);
const guard = () => assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
const restoreValue = (v: unknown) => (v === undefined ? FieldValue.delete() : v);
const monitorsPath = () => `/sa/${primaryId()}/ai-agents/monitors`;

let prior: Record<string, unknown> = {};

test.beforeAll(async () => {
  await guard();
  const data = (await primaryRef().get()).data() ?? {};
  prior = {
    labsEnabledByAgency: data.labsEnabledByAgency,
    agentsEnabledByAgency: data.agentsEnabledByAgency,
  };
});

test.afterAll(async () => {
  await guard();
  await primaryRef().update({
    labsEnabledByAgency: restoreValue(prior.labsEnabledByAgency),
    agentsEnabledByAgency: restoreValue(prior.agentsEnabledByAgency),
  });
});

async function setGates(gates: { labs: boolean; agents: boolean }) {
  await guard();
  await primaryRef().update({
    labsEnabledByAgency: gates.labs,
    agentsEnabledByAgency: gates.agents,
  });
}

/** In-page so the session cookie goes with it (page.request drops it on loopback). */
function staleDealsStatus(page: Page) {
  const url = `/api/sub-accounts/${primaryId()}/agents/stale-deals`;
  return page.evaluate(async (u) => (await fetch(u)).status, url);
}

test("both gates on: the tab and both monitor cards, stale deals loaded from its route", async ({ page }) => {
  await setGates({ labs: true, agents: true });
  await page.goto(monitorsPath());
  await expect(page.getByRole("heading", { name: "Monitors", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: /Monitors/ })).toBeVisible();

  const stale = page.getByTestId("monitor-stale-deals");
  await expect(stale.getByRole("heading", { name: "Stale deals" })).toBeVisible({ timeout: 30_000 });
  // The controls render only once the config GET answered.
  await expect(stale.getByText("Enable the stale deals monitor")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("monitor-watchdog")).toBeVisible();
  await expect(page.getByTestId("monitor-stale-deals-locked")).toHaveCount(0);
  expect(await staleDealsStatus(page)).toBe(200);
});

test("Agent monitors off: stale deals is locked and its route 403s; the watchdog stays", async ({ page }) => {
  await setGates({ labs: true, agents: false });
  await page.goto(monitorsPath());
  await expect(page.getByTestId("monitor-stale-deals-locked")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("monitor-stale-deals")).toHaveCount(0);
  await expect(page.getByTestId("monitor-watchdog")).toBeVisible();
  expect(await staleDealsStatus(page)).toBe(403);
});

test("both gates off: no Monitors tab, and the page shows two locks", async ({ page }) => {
  await setGates({ labs: false, agents: false });
  await page.goto(`/sa/${primaryId()}/ai-agents`);
  // The Voice tab is a sibling in the same nav: the nav has rendered.
  await expect(page.getByRole("link", { name: "Voice", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: /Monitors/ })).toHaveCount(0);

  await page.goto(monitorsPath());
  await expect(page.getByTestId("monitor-watchdog-locked")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("monitor-stale-deals-locked")).toBeVisible();
  await expect(page.getByTestId("monitor-watchdog")).toHaveCount(0);
  await expect(page.getByTestId("monitor-stale-deals")).toHaveCount(0);
});
