import { expect, test, type Page } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";

/**
 * SP13 X1 — the agency Manage dialog must show the gates Firestore holds and
 * must not revert a gate it was never asked to change.
 *
 * The defect (proven on #1000, 2026-09-15): the dialog's checkbox state was
 * seeded while `subAccount` was still null and re-synced on open by a
 * hand-maintained effect the newest gates were missing from, so those gates
 * rendered unchecked whatever Firestore said — and because Save sends only
 * the fields that differ from the doc, every Save switched them off.
 *
 * Flow: both gates off → Save 1 turns Google on → full reload (state is
 * re-seeded from a null doc, the exact prod path) → the dialog must show
 * Google ON → Save 2 turns Labs on → both must be true in Firestore.
 * Then, in the SAME page load: while the dialog is closed Firestore turns
 * Google Calendar sync on, and reopening must show it — the close/reopen path
 * where the old component kept its hook state between opens.
 */

const GOOGLE = "googleEnabledByAgency";
const LABS = "labsEnabledByAgency";
const GCAL = "googleCalendarEnabledByAgency";
const AGENT_API = "agentApiEnabledByAgency";

async function gates(sa: string) {
  const d = (await adminDb().doc(`subAccounts/${sa}`).get()).data() ?? {};
  return {
    google: d[GOOGLE] === true,
    labs: d[LABS] === true,
    gcal: d[GCAL] === true,
    agentApi: d[AGENT_API] === true,
  };
}

async function openManage(page: Page) {
  await page.goto("/agency/sub-accounts");
  await page
    .getByRole("row", { name: new RegExp(FIXTURE_PRIMARY_NAME) })
    .getByRole("button", { name: "Manage" })
    .click();
  await expect(
    page.getByRole("heading", { name: `Manage ${FIXTURE_PRIMARY_NAME}` }),
  ).toBeVisible();
}

test("two sequential Manage saves both persist", async ({ page }) => {
  const env = readEnv();
  const sa = env.E2E_SUBACCOUNT_ID;
  const ref = adminDb().doc(`subAccounts/${sa}`);
  const before = await gates(sa);
  await ref.update({ [GOOGLE]: false, [LABS]: false, [GCAL]: false, [AGENT_API]: false });

  try {
    // Save 1 — Google on.
    await openManage(page);
    const google = page.getByRole("checkbox", { name: /^Google Business Profile/ });
    await expect(google).not.toBeChecked();
    await google.check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => gates(sa).then((g) => g.google), { timeout: 15_000 }).toBe(true);

    // Reload — a fresh mount reads Firestore, not leftover component state.
    await page.reload();
    await openManage(page);
    await expect(
      page.getByRole("checkbox", { name: /^Google Business Profile/ }),
    ).toBeChecked();

    // Save 2 — Labs on. Google must survive it.
    const labs = page.getByRole("checkbox", { name: /^Labs/ });
    await expect(labs).not.toBeChecked();
    await labs.check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => gates(sa).then((g) => g.labs), { timeout: 15_000 }).toBe(true);
    expect(await gates(sa)).toEqual({
      google: true,
      labs: true,
      gcal: false,
      agentApi: false,
    });

    // Save 3 — Agent API on. Google + Labs must survive it. Save 2 closed
    // the dialog, so reopen it first.
    await openManage(page);
    const agentApi = page.getByRole("checkbox", { name: /^Agent API/ });
    await expect(agentApi).not.toBeChecked();
    await agentApi.check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(() => gates(sa).then((g) => g.agentApi), { timeout: 15_000 })
      .toBe(true);
    expect(await gates(sa)).toEqual({
      google: true,
      labs: true,
      gcal: false,
      agentApi: true,
    });

    // Close → Firestore changes → reopen, no reload.
    await expect(
      page.getByRole("heading", { name: `Manage ${FIXTURE_PRIMARY_NAME}` }),
    ).toBeHidden();
    await ref.update({ [GCAL]: true });
    // The dialog seeds its state once per mount, so a reopen that beats the
    // list's onSnapshot delivery would bake in the old value. Reopen until the
    // listener has caught up — the old component never shows it checked, so
    // retrying cannot turn a real regression green.
    await expect(async () => {
      if (await page.getByRole("dialog").isVisible()) {
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toBeHidden();
      }
      await page
        .getByRole("row", { name: new RegExp(FIXTURE_PRIMARY_NAME) })
        .getByRole("button", { name: "Manage" })
        .click();
      await expect(
        page.getByRole("checkbox", { name: /Google Calendar sync/ }),
      ).toBeChecked({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  } finally {
    await ref.update({
      [GOOGLE]: before.google,
      [LABS]: before.labs,
      [GCAL]: before.gcal,
      [AGENT_API]: before.agentApi,
    });
  }
});
