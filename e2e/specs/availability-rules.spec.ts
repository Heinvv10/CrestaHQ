import { expect, test, type Page } from "@playwright/test";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { deleteScoped } from "../lib/guard";

/**
 * SP3 (b) availability rules, end to end on the public page: a date
 * override closes a normally-open date and opens a normally-closed one;
 * before/after buffers remove the slots next to a manual event; a 15-min
 * interval on a 30-min page offers quarter-hour starts. Plus the editor
 * saving a date-specific closure.
 *
 * Pages open 21:00–24:00 UTC (the browser runs in UTC) — evening, because a
 * hostless page is blocked by ANY event in the sub-account and other specs
 * book the shared fixture in business hours.
 */

test.use({ timezoneId: "UTC", locale: "en-US" });

const PREFIX = "e2e-avail-";
const env = readEnv();
const sa = env.E2E_SUBACCOUNT_ID;
const stamp = Date.now();

const dayOffset = (n: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n));
};
const TOMORROW = dayOffset(1);
const DAY_AFTER = dayOffset(2);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const at = (day: Date, hhmm: string) => new Date(`${ymd(day)}T${hhmm}:00Z`);
const time = (label: string) => new RegExp(`^${label.replace(" ", "\\s")}`);
const EVENING = { startMinute: 21 * 60, endMinute: 24 * 60 };

async function seedPage(slug: string, over: Record<string, unknown>) {
  await adminDb()
    .doc(`subAccounts/${sa}/bookingPages/${slug}`)
    .set({
      id: slug,
      slug,
      name: `E2E Avail ${slug}`,
      description: "",
      status: "published",
      durationMinutes: 30,
      bufferMinutes: 0,
      workingHours: [{ dayOfWeek: TOMORROW.getUTCDay(), ...EVENING }],
      timezone: "UTC",
      visibleDays: 3,
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

/** A shared manual calendar entry tomorrow. */
async function seedBusy(start: string, end: string) {
  await adminDb()
    .collection("events")
    .add({
      title: "E2E Avail busy",
      startAt: Timestamp.fromDate(at(TOMORROW, start)),
      endAt: Timestamp.fromDate(at(TOMORROW, end)),
      contactId: null,
      location: "",
      notes: "",
      agencyId: env.E2E_AGENCY_ID,
      subAccountId: sa,
      createdByUid: "e2e",
      territoryId: "global",
      status: "scheduled",
      source: "manual",
      assignedToUid: null,
      assignedToName: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
}

/** Every event and page this spec made, in this or an earlier crashed run. */
async function purge() {
  const events = await adminDb().collection("events").where("subAccountId", "==", sa).get();
  for (const d of events.docs) {
    const e = d.data();
    const slug = typeof e.bookingPageSlug === "string" ? e.bookingPageSlug : "";
    if (slug.startsWith(PREFIX) || e.title === "E2E Avail busy") await deleteScoped(d.ref);
  }
  const pages = await adminDb().collection(`subAccounts/${sa}/bookingPages`).get();
  for (const d of pages.docs) {
    if (d.id.startsWith(PREFIX)) await deleteScoped(d.ref);
  }
}

async function slotStarts(page: Page, slug: string): Promise<string[]> {
  const res = await page.request.get(`/api/booking/${sa}/${slug}/availability`);
  expect(res.status()).toBe(200);
  return ((await res.json()).slots as { startAt: string }[]).map((s) => s.startAt);
}

test.beforeAll(purge);
test.afterEach(purge);

test("a date override closes a normally-open date and opens a normally-closed one", async ({ page }) => {
  const slug = `${PREFIX}override-${stamp}`;
  await seedPage(slug, {
    dateOverrides: [
      { date: ymd(TOMORROW), ranges: [] },
      { date: ymd(DAY_AFTER), ranges: [{ startMinute: 21 * 60, endMinute: 22 * 60 }] },
    ],
  });

  expect(await slotStarts(page, slug)).toEqual([
    at(DAY_AFTER, "21:00").toISOString(),
    at(DAY_AFTER, "21:30").toISOString(),
  ]);

  await page.goto(`/b/${sa}/${slug}`);
  const heading = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(at(DAY_AFTER, "12:00"));
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: time("9:30 PM") })).toBeVisible();
  await expect(page.getByRole("button", { name: time("10:00 PM") })).toHaveCount(0);
});

test("a before-buffer removes the slot right after a manual event", async ({ page }) => {
  const slug = `${PREFIX}before-${stamp}`;
  await seedPage(slug, { bufferBeforeMinutes: 15 });
  await seedBusy("21:05", "21:20"); // off-grid

  await page.goto(`/b/${sa}/${slug}`);
  await expect(page.getByRole("button", { name: time("10:00 PM") })).toBeVisible({ timeout: 30_000 });
  // 9:30 PM needs 9:15–9:30 free; the event runs to 9:20.
  await expect(page.getByRole("button", { name: time("9:30 PM") })).toHaveCount(0);
});

test("an after-buffer removes the slot right before a manual event", async ({ page }) => {
  const slug = `${PREFIX}after-${stamp}`;
  await seedPage(slug, { bufferMinutes: 15, slotIntervalMinutes: 30 });
  await seedBusy("22:10", "22:20");

  await page.goto(`/b/${sa}/${slug}`);
  await expect(page.getByRole("button", { name: time("9:00 PM") })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: time("10:30 PM") })).toBeVisible();
  // 9:30 PM needs 10:00–10:15 free; the event starts 10:10.
  await expect(page.getByRole("button", { name: time("9:30 PM") })).toHaveCount(0);
});

test("a booking on the page keeps its after-buffer: no slot right after it, even at interval 15", async ({ page }) => {
  const slug = `${PREFIX}own-${stamp}`;
  await seedPage(slug, { bufferMinutes: 15, slotIntervalMinutes: 15 });
  const res = await page.request.post(`/api/booking/${sa}/${slug}/book`, {
    data: {
      slot: { startAt: at(TOMORROW, "21:00").toISOString(), endAt: at(TOMORROW, "21:30").toISOString() },
      name: `E2E Avail Visitor ${stamp}`,
      email: `e2e-avail-${stamp}@example.com`,
      phone: "+27600000000",
    },
  });
  expect(res.status()).toBe(200);

  await page.goto(`/b/${sa}/${slug}`);
  await expect(page.getByRole("button", { name: time("9:45 PM") })).toBeVisible({ timeout: 30_000 });
  // 9:30 PM would start the moment the 9:00 booking ends; its 15-min buffer forbids it.
  await expect(page.getByRole("button", { name: time("9:30 PM") })).toHaveCount(0);
});

test("a 15-minute interval on a 30-minute page offers quarter-hour starts, bookable", async ({ page }) => {
  const slug = `${PREFIX}interval-${stamp}`;
  await seedPage(slug, { slotIntervalMinutes: 15 });

  await page.goto(`/b/${sa}/${slug}`);
  await page.getByRole("button", { name: time("9:15 PM") }).click({ timeout: 30_000 });
  await page.locator("#b-name").fill(`E2E Avail Visitor ${stamp}`);
  await page.locator("#b-email").fill(`e2e-avail-${stamp}@example.com`);
  await page.locator("#b-phone").fill("+27600000000");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByText("You're booked.")).toBeVisible({ timeout: 30_000 });

  const booked = await adminDb()
    .collection("events")
    .where("subAccountId", "==", sa)
    .where("bookingPageSlug", "==", slug)
    .get();
  expect(booked.size).toBe(1);
  expect((booked.docs[0].data().startAt as Timestamp).toDate().toISOString()).toBe(
    at(TOMORROW, "21:15").toISOString(),
  );
});

test("the editor saves a date-specific closure", async ({ page }) => {
  const slug = `${PREFIX}editor-${stamp}`;
  await seedPage(slug, {});

  await page.goto(`/sa/${sa}/booking/${slug}`);
  const group = page.getByRole("group", { name: "Date-specific hours" });
  await group.getByRole("button", { name: "Add date" }).click({ timeout: 30_000 });
  await group.getByLabel("Date", { exact: true }).fill(ymd(TOMORROW));
  await group.getByLabel("Unavailable all day").check();
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect
    .poll(async () => (await adminDb().doc(`subAccounts/${sa}/bookingPages/${slug}`).get()).data()?.dateOverrides, {
      timeout: 30_000,
    })
    .toEqual([{ date: ymd(TOMORROW), ranges: [] }]);
  expect(await slotStarts(page, slug)).toEqual([]);
});
