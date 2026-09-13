import { FieldValue } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { ensureBookingStatusSeed } from "../lib/seed";

/**
 * SP3 (f) — appointments list, driven through the real UI:
 *   1. Tabs (Upcoming / Cancelled / All) bucket correctly.
 *   2. The Calendar filter narrows to one booking page.
 *   3. Search matches by contact name.
 *   4. A row-menu status change (Mark completed) updates the badge AND
 *      the Firestore doc.
 */

async function ensureContact(
  agencyId: string,
  subAccountId: string,
  createdByUid: string,
  name: string,
): Promise<string> {
  const ref = await adminDb().collection("contacts").add({
    name,
    email: "",
    phone: "",
    company: "",
    address: "",
    source: "e2e-fixture",
    tags: [],
    pipelineStage: null,
    attribution: null,
    agencyId,
    subAccountId,
    createdByUid,
    emailOptedOut: false,
    smsOptedOut: false,
    territoryId: "global",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

async function createEvent(opts: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  contactId: string;
  title: string;
  status: "scheduled" | "cancelled";
  startAt: Date;
  bookingPageSlug?: string;
  source: "booking_page" | "manual";
}): Promise<string> {
  const endAt = new Date(opts.startAt.getTime() + 30 * 60_000);
  const ref = await adminDb().collection("events").add({
    title: opts.title,
    startAt: opts.startAt,
    endAt,
    contactId: opts.contactId,
    location: "",
    notes: "",
    agencyId: opts.agencyId,
    subAccountId: opts.subAccountId,
    createdByUid: opts.createdByUid,
    status: opts.status,
    source: opts.source,
    bookingPageSlug: opts.bookingPageSlug ?? null,
    territoryId: "global",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await ref.update({ id: ref.id });
  return ref.id;
}

test("tabs, calendar filter, search, and a row-menu status change all work", async ({
  page,
}) => {
  const env = readEnv();
  const agencyId = env.E2E_AGENCY_ID;
  const subAccountId = env.E2E_SUBACCOUNT_ID;
  const stamp = Date.now();
  const { pageXSlug, pageYSlug } = await ensureBookingStatusSeed();

  const ownerSnap = await adminDb().doc(`agencies/${agencyId}`).get();
  const uid = ownerSnap.data()?.ownerUid as string;

  const contactUpcoming = await ensureContact(
    agencyId,
    subAccountId,
    uid,
    `E2E Appt Upcoming ${stamp}`,
  );
  const contactCancelled = await ensureContact(
    agencyId,
    subAccountId,
    uid,
    `E2E Appt Cancelled ${stamp}`,
  );
  const contactManual = await ensureContact(
    agencyId,
    subAccountId,
    uid,
    `E2E Appt Manual ${stamp}`,
  );

  const titleUpcoming = `E2E Appt Upcoming Booking ${stamp}`;
  const titleCancelled = `E2E Appt Cancelled Booking ${stamp}`;
  const titleManual = `E2E Appt Manual Meeting ${stamp}`;

  const upcomingEventId = await createEvent({
    agencyId,
    subAccountId,
    createdByUid: uid,
    contactId: contactUpcoming,
    title: titleUpcoming,
    status: "scheduled",
    startAt: new Date(Date.now() + 24 * 60 * 60_000), // tomorrow
    bookingPageSlug: pageXSlug,
    source: "booking_page",
  });
  await createEvent({
    agencyId,
    subAccountId,
    createdByUid: uid,
    contactId: contactCancelled,
    title: titleCancelled,
    status: "cancelled",
    startAt: new Date(Date.now() + 24 * 60 * 60_000),
    bookingPageSlug: pageYSlug,
    source: "booking_page",
  });
  await createEvent({
    agencyId,
    subAccountId,
    createdByUid: uid,
    contactId: contactManual,
    title: titleManual,
    status: "scheduled",
    startAt: new Date(Date.now() + 48 * 60 * 60_000),
    source: "manual",
  });

  await page.goto(`/sa/${subAccountId}/calendar/appointments`);
  const searchBox = page.getByPlaceholder("Search by title or contact…");

  // The fixture tenant accumulates events across e2e runs, so the table can
  // exceed the page size — scope every tab/filter assertion below to just
  // this run's 3 events via the shared stamp, or a row pushed past "Load
  // more" would read as "missing" instead of "wrongly filtered".
  await searchBox.fill(String(stamp));

  // --- tabs ---------------------------------------------------------
  // Default tab is Upcoming: the two scheduled-and-future events, not the
  // cancelled one.
  await expect(page.getByText(titleUpcoming, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(titleManual, { exact: true })).toBeVisible();
  await expect(page.getByText(titleCancelled, { exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: /Cancelled/ }).click();
  await expect(page.getByText(titleCancelled, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(titleUpcoming, { exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: /^All/ }).click();
  await expect(page.getByText(titleUpcoming, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(titleCancelled, { exact: true })).toBeVisible();
  await expect(page.getByText(titleManual, { exact: true })).toBeVisible();

  // --- Calendar filter (still on the All tab, still stamp-scoped) ----
  await page.getByLabel("Calendar").selectOption({ label: "E2E Fixture Page X" });
  await expect(page.getByText(titleUpcoming, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(titleCancelled, { exact: true })).toHaveCount(0);
  await expect(page.getByText(titleManual, { exact: true })).toHaveCount(0);
  await page.getByLabel("Calendar").selectOption({ label: "Any calendar" });

  // --- search (narrower than the stamp: one contact's name) ----------
  await searchBox.fill(`E2E Appt Manual ${stamp}`);
  await expect(page.getByText(titleManual, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(titleUpcoming, { exact: true })).toHaveCount(0);

  // --- row-menu status change ------------------------------------------
  // On the All tab (not Upcoming): marking the booking "completed" makes
  // it stop occupying a slot, so it would drop OUT of the Upcoming tab the
  // moment the status flips — the row itself would vanish rather than
  // showing the updated badge in place. All never filters by status, so
  // the row stays put and we can watch its badge change.
  await page.getByRole("tab", { name: /^All/ }).click();
  await searchBox.fill(String(stamp));
  const upcomingRow = page.locator("tr").filter({ hasText: titleUpcoming });
  await expect(upcomingRow).toBeVisible({ timeout: 15_000 });
  await upcomingRow.getByRole("button").last().click();
  await page.getByRole("menuitem", { name: "Mark completed" }).click();

  await expect(upcomingRow.getByText("Showed", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(
      async () => (await adminDb().doc(`events/${upcomingEventId}`).get()).data()?.status,
      { timeout: 15_000 },
    )
    .toBe("completed");
});
