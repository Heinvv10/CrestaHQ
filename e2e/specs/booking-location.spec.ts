import { expect, test, type Page } from "@playwright/test";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertWindowsClear } from "../lib/booking-windows";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { runId } from "../lib/run-id";

/**
 * Booking locations on the real public page: an "at their place" page shows
 * its location line, asks the booker for the visit address, refuses markup
 * in it through the real book route, and stores the address on the event's
 * location. An in-person page shows the business's own address.
 *
 * The page opens 03:00–05:00 UTC five days out, a window no other booking
 * spec uses (a hostless page is blocked by ANY event in the sub-account),
 * and the browser runs in UTC.
 */

test.use({ timezoneId: "UTC", locale: "en-US" });

const BASE_PREFIX = "e2e-loc-";
const PREFIX = `${BASE_PREFIX}${runId()}-`;
const STALE_MS = 6 * 3600_000;
const env = readEnv();
const sa = env.E2E_SUBACCOUNT_ID;
const stamp = Date.now();

const now = new Date();
const DAY = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 5));
const at = (hhmm: string) => new Date(`${DAY.toISOString().slice(0, 10)}T${hhmm}:00Z`);
const time = (label: string) => new RegExp(`^${label.replace(" ", "\\s")}`);

async function seedPage(slug: string, location: { type: string; value: string | null }) {
  await adminDb()
    .doc(`subAccounts/${sa}/bookingPages/${slug}`)
    .set({
      id: slug,
      slug,
      name: `E2E Location ${slug}`,
      description: "",
      status: "published",
      durationMinutes: 30,
      bufferMinutes: 0,
      workingHours: [{ dayOfWeek: DAY.getUTCDay(), startMinute: 180, endMinute: 300 }],
      timezone: "UTC",
      visibleDays: 6,
      minNoticeHours: 0,
      maxPerDay: null,
      intakeFields: [],
      logoUrl: null,
      accentColor: null,
      meetingUrl: null,
      googleMeet: false,
      location,
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
    });
}

/** True once createdAt is older than STALE_MS — left by a crashed run. */
function isStale(createdAt: unknown): boolean {
  if (!(createdAt instanceof Timestamp)) return false;
  return Date.now() - createdAt.toMillis() > STALE_MS;
}

/** This run's events and pages, plus BASE_PREFIX leftovers old enough to be a crashed run's. */
async function purge() {
  const events = await adminDb().collection("events").where("subAccountId", "==", sa).get();
  for (const d of events.docs) {
    const e = d.data();
    const slug = typeof e.bookingPageSlug === "string" ? e.bookingPageSlug : "";
    if (slug.startsWith(PREFIX) || (slug.startsWith(BASE_PREFIX) && isStale(e.createdAt))) {
      await deleteScoped(d.ref);
    }
  }
  const pages = await adminDb().collection(`subAccounts/${sa}/bookingPages`).get();
  for (const d of pages.docs) {
    if (d.id.startsWith(PREFIX) || (d.id.startsWith(BASE_PREFIX) && isStale(d.data().createdAt))) {
      await deleteScoped(d.ref);
    }
  }
}

/** POST from the page, as the booking form itself does. */
async function postFromPage(page: Page, path: string, body: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.status;
    },
    { path, body },
  );
}

test.beforeAll(async () => {
  await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
  await purge();
  await assertWindowsClear(
    sa,
    [[at("03:00"), at("05:00")]],
    (e) => String(e.bookingPageSlug ?? "").startsWith(PREFIX),
  );
});
test.afterAll(purge);

test("an in-person page shows the business's address", async ({ page }) => {
  const slug = `${PREFIX}office-${stamp}`;
  await seedPage(slug, { type: "in_person", value: "12 Main Rd, Sandton" });
  await page.goto(`/b/${sa}/${slug}`);
  await expect(page.getByText("In person at 12 Main Rd, Sandton")).toBeVisible({ timeout: 30_000 });
});

test("'at their place': the booker's address is asked, markup refused, and stored on the event", async ({ page }) => {
  const slug = `${PREFIX}visit-${stamp}`;
  await seedPage(slug, { type: "their_address", value: null });
  await page.goto(`/b/${sa}/${slug}`);
  await expect(page.getByText("At your address")).toBeVisible({ timeout: 30_000 });

  // The real book route refuses markup in the address before any write.
  const refused = await postFromPage(page, `/api/booking/${sa}/${slug}/book`, {
    slot: { startAt: at("03:00").toISOString(), endAt: at("03:30").toISOString() },
    name: `E2E Location Visitor ${stamp}`,
    email: `e2e-loc-${stamp}@example.com`,
    phone: "+27600000000",
    address: "<b>1 Evil St</b>",
  });
  expect(refused).toBe(400);

  await page.getByRole("button", { name: time("3:00 AM") }).click({ timeout: 30_000 });
  await page.locator("#b-name").fill(`E2E Location Visitor ${stamp}`);
  await page.locator("#b-email").fill(`e2e-loc-${stamp}@example.com`);
  await page.locator("#b-phone").fill("+27600000000");
  await expect(page.getByLabel(/Address for the visit/)).toBeVisible();
  await page.getByLabel(/Address for the visit/).fill("7 Oak Ave, Pretoria");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByText("You're booked.")).toBeVisible({ timeout: 30_000 });

  const events = await adminDb()
    .collection("events")
    .where("subAccountId", "==", sa)
    .where("bookingPageSlug", "==", slug)
    .get();
  expect(events.docs.map((d) => d.data().location)).toEqual(["At your address: 7 Oak Ave, Pretoria"]);
});
