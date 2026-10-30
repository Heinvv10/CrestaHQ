import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";

/**
 * Port 1.0.54 C2 — the Google Calendar import UI, against this PR's build:
 * the settings controls (workspace allowance, per-member mode, Sync now) and
 * the calendar page rendering an imported event read-only. The app runs
 * GCAL_PROVIDER=fake (fenced to loopback + the fixture agency); the owner's
 * "Google calendar" is `private/googleCalendarFake_{uid}` and their connection
 * is seeded with fake-bound tokens (connect itself is google-calendar-sync.spec.ts,
 * the API contract is google-calendar-import.spec.ts).
 *
 * Writes only to the fixture PRIMARY sub-account, identity-asserted first;
 * restores the gate and the allowance, and deletes every doc it made.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GCAL_PROVIDER=fake, which a deployed target refuses by design");

const env = () => readEnv();
const SA = () => env().E2E_SUBACCOUNT_ID;
const primaryRef = () => adminDb().doc(`subAccounts/${SA()}`);
const guard = () => assertFixtureSubAccount(SA(), FIXTURE_PRIMARY_NAME);
/** Calendar months from now that the event is placed, so a busy day-of-month on the shared tenant is unlikely. */
const MONTHS_AHEAD = 3;
/** A title and place that must never reach the CRM in time-only mode. */
const SECRET_TITLE = "E2E-private-dentist";
const SECRET_PLACE = "E2E-private-place";

let ownerUid = "";
let prior: { gate: unknown; allowed: unknown } = { gate: undefined, allowed: undefined };
const privateDoc = (id: string) => primaryRef().collection("private").doc(id);
const connection = () => privateDoc(`googleCalendar_${ownerUid}`);
const fakeCalendar = () => privateDoc(`googleCalendarFake_${ownerUid}`);
const imports = async () =>
  (
    await adminDb()
      .collection("events")
      .where("subAccountId", "==", SA())
      .where("source", "==", "google")
      .where("importOwnerUid", "==", ownerUid)
      .get()
  ).docs;

/** The 15th, noon UTC, MONTHS_AHEAD months out: inside the import window wherever CI runs. */
const eventTime = (hours: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + MONTHS_AHEAD, 15, hours)).toISOString();
};

async function clearImport(): Promise<void> {
  await guard();
  // The private docs carry no subAccountId; their parent was asserted above.
  await connection().delete();
  await fakeCalendar().delete();
  for (const d of await imports()) await deleteScoped(d.ref);
}

test.beforeAll(async () => {
  await guard();
  ownerUid = (await adminDb().doc(`agencies/${env().E2E_AGENCY_ID}`).get()).data()?.ownerUid;
  expect(ownerUid).toBeTruthy();
  const sub = (await primaryRef().get()).data();
  prior = { gate: sub?.googleCalendarEnabledByAgency, allowed: sub?.calendarImportAllowed };
  await clearImport();
  await primaryRef().update({ googleCalendarEnabledByAgency: true, calendarImportAllowed: false });
  const n = Date.now().toString(36);
  await connection().set({
    uid: ownerUid,
    agencyId: env().E2E_AGENCY_ID,
    subAccountId: SA(),
    googleEmail: "fixture-host@example.invalid",
    refreshToken: `fake-gcal-refresh:${SA()}:${ownerUid}:${n}`,
    accessToken: `fake-gcal-access:${SA()}:${ownerUid}:${n}`,
    accessTokenExpiresAt: Date.now() + 3_600_000,
    scopes: [],
    status: "connected",
    connectedAt: new Date(),
    lastError: null,
    lastErrorAt: null,
  });
  await fakeCalendar().set({
    events: [
      {
        id: "e2e-import-ui-1",
        status: "confirmed",
        summary: SECRET_TITLE,
        location: SECRET_PLACE,
        start: { dateTime: eventTime(12) },
        end: { dateTime: eventTime(13) },
      },
    ],
  });
});

test.afterAll(async () => {
  await clearImport();
  await primaryRef().update({
    googleCalendarEnabledByAgency: prior.gate === undefined ? FieldValue.delete() : prior.gate,
    calendarImportAllowed: prior.allowed === undefined ? FieldValue.delete() : prior.allowed,
  });
});

test("settings turn import on, and the calendar shows the event read-only as Busy", async ({ page }) => {
  await page.goto(`/sa/${SA()}/dashboard/settings`);
  await expect(page.getByTestId("gcal-import")).toBeVisible({ timeout: 30_000 });

  // Allowance is off: no mode buttons yet.
  const allow = page.getByTestId("gcal-import-allow");
  await expect(allow).not.toBeChecked();
  await expect(page.getByTestId("gcal-import-mode-busy")).toHaveCount(0);

  // Controlled by the server's answer, so click and wait rather than check().
  await allow.click();
  await expect(allow).toBeChecked({ timeout: 15_000 });
  await page.getByTestId("gcal-import-mode-busy").click();
  await expect(page.getByTestId("gcal-import-mode-busy")).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });

  // The mode change starts the first pass after the response; the panel polls until it lands.
  await expect(page.getByTestId("gcal-import-status")).toContainText(/^1 events, synced/, { timeout: 45_000 });
  await expect.poll(async () => (await imports()).length, { timeout: 30_000 }).toBe(1);
  expect(JSON.stringify((await imports())[0].data())).not.toContain(SECRET_TITLE);

  // The calendar: a marked chip reading Busy, never the Google title or place.
  await page.goto(`/sa/${SA()}/calendar`);
  for (let i = 0; i < MONTHS_AHEAD; i++) await page.getByRole("button", { name: "Next month" }).click();
  const chip = page.locator('[data-imported="true"]').first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toContainText("Busy");
  await expect(page.locator("body")).not.toContainText(SECRET_TITLE);

  // Opening it is read-only: no form, no Save, no Delete, and the marker says where it is from.
  await chip.click();
  const sheet = page.getByTestId("imported-event-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Imported from Google");
  await expect(sheet).toContainText("Busy only");
  await expect(page.locator("#ev-title")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: /save|delete|cancel/i })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Off removes it from the calendar.
  await page.goto(`/sa/${SA()}/dashboard/settings`);
  await page.getByTestId("gcal-import-mode-off").click();
  await expect.poll(async () => (await imports()).length, { timeout: 30_000 }).toBe(0);
  await page.goto(`/sa/${SA()}/calendar`);
  for (let i = 0; i < MONTHS_AHEAD; i++) await page.getByRole("button", { name: "Next month" }).click();
  await expect(page.locator('[data-imported="true"]')).toHaveCount(0);
});
