import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { deleteScoped } from "../lib/guard";
import { ensureBookingStatusSeed } from "../lib/seed";
import { runId } from "../lib/run-id";

/**
 * SP3 (f) - appointments list, driven through the real UI:
 *   1. Tabs (Upcoming / Cancelled / All) bucket correctly.
 *   2. The Calendar filter narrows to one booking page.
 *   3. Search matches by contact name.
 *   4. A row-menu status change (Mark completed) updates the badge AND
 *      the Firestore doc.
 *   5. A manual event's row menu offers no status actions (H1) - only a
 *      booking-page event has a lifecycle to flip.
 *   6. Cancel goes through an in-app AlertDialog (H2), never a native
 *      window.confirm (which freezes browser automation): dismissing it
 *      leaves the booking untouched, confirming it cancels for real.
 *
 * Fixture hygiene: every event here is assigned to ONE fixture host
 * (HOST) - an event with no host is "shared busy" and blocks EVERY
 * hostless booking page's every slot (see eventHostUids in
 * lib/booking/page-slots.ts + how loadEventBusy in
 * lib/booking/resolve-availability.ts feeds it into computeAvailability).
 * An earlier version left a hostless "E2E Appt Manual Meeting" event
 * uncleaned and it broke availability-rules.spec on main (Tuesday 21:00
 * hidden). Seeded at 09:00-12:00 UTC "tomorrow", away from
 * calendar-types.spec.ts's own 21:00-24:00 UTC window, and purged before
 * (crash recovery) AND after every run.
 */

// Run-scoped so this run's fixture host member doc can't collide with a
// concurrent run's (see e2e/lib/run-id.ts). NOTE: purge() below scopes by
// TITLE_PREFIX, a title-text range, not this PREFIX — see the note there.
const PREFIX = `e2e-appt-${runId()}-`;
const HOST = { uid: `${PREFIX}host`, name: "E2E Appt Host" };

const env = readEnv();
const agencyId = env.E2E_AGENCY_ID;
const subAccountId = env.E2E_SUBACCOUNT_ID;

const now = new Date();
const tomorrow = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
);
const at = (hhmm: string) =>
  new Date(`${tomorrow.toISOString().slice(0, 10)}T${hhmm}:00Z`);

function members() {
  return adminDb().collection(`subAccounts/${subAccountId}/subAccountMembers`);
}

// Standard Firestore "starts with" range trick: appending the highest
// BMP codepoint sorts after every normal title/name, so [prefix, end)
// matches everything this spec ever named, across any stamp. TITLE_PREFIX
// stays bare (no run id) so the range still catches every run's docs, for
// stale-crash cleanup below; RUN_TITLE_PREFIX is what THIS run actually
// seeds with, so a concurrent run's purge (its own docs, plus anything
// stale) never sweeps this run's still-live fixtures (see
// e2e/lib/run-id.ts).
const TITLE_PREFIX = "E2E Appt ";
const TITLE_PREFIX_END = TITLE_PREFIX + "\uF8FF";
const RUN_TITLE_PREFIX = `${TITLE_PREFIX}${runId()} `;
const STALE_MS = 6 * 3600_000;

/** True once createdAt/addedAt is older than STALE_MS - a doc an earlier,
 * crashed run never cleaned up, not a concurrent run's still-live fixture. */
function isStale(timestamp: unknown): boolean {
  if (!(timestamp instanceof Timestamp)) return false;
  return Date.now() - timestamp.toMillis() > STALE_MS;
}

/**
 * Every contact/event this spec made, in this run or an earlier crashed
 * one. Filters by title/name range ONLY (no subAccountId equality) —
 * combining them needs a composite index that doesn't exist on this
 * project; a single-field range query is auto-indexed. `deleteScoped`
 * independently re-verifies subAccountId/agencyId before deleting, so
 * scoping isn't weakened, just moved from the query to the guard.
 */
async function purge() {
  const events = await adminDb()
    .collection("events")
    .where("title", ">=", TITLE_PREFIX)
    .where("title", "<", TITLE_PREFIX_END)
    .get();
  for (const d of events.docs) {
    const e = d.data();
    if (e.subAccountId !== subAccountId) continue;
    const title = typeof e.title === "string" ? e.title : "";
    const ours = title.startsWith(RUN_TITLE_PREFIX);
    const stale = !ours && isStale(e.createdAt);
    if (ours || stale) await deleteScoped(d.ref);
  }

  const contacts = await adminDb()
    .collection("contacts")
    .where("name", ">=", TITLE_PREFIX)
    .where("name", "<", TITLE_PREFIX_END)
    .get();
  for (const d of contacts.docs) {
    const c = d.data();
    if (c.subAccountId !== subAccountId) continue;
    const name = typeof c.name === "string" ? c.name : "";
    const ours = name.startsWith(RUN_TITLE_PREFIX);
    const stale = !ours && isStale(c.createdAt);
    if (ours || stale) await deleteScoped(d.ref);
  }
}

// Bare prefix for the HOST member doc, so a stale one left by a crashed run
// can be found and purged too (member docs carry no title/name to range
// query on, so this is a separate uid-range query, same shape as above).
const HOST_UID_PREFIX = "e2e-appt-";

async function purgeStaleHosts() {
  const snap = await members()
    .where("uid", ">=", HOST_UID_PREFIX)
    .where("uid", "<", HOST_UID_PREFIX + "\uF8FF")
    .get();
  for (const d of snap.docs) {
    const m = d.data();
    if (m.subAccountId !== subAccountId || d.id === HOST.uid) continue;
    if (isStale(m.addedAt)) await deleteScoped(d.ref);
  }
}

test.beforeAll(async () => {
  await purge();
  await purgeStaleHosts();
  await members().doc(HOST.uid).set({
    uid: HOST.uid,
    subAccountId,
    agencyId,
    role: "collaborator",
    status: "active",
    email: `${HOST.uid}@example.com`,
    displayName: HOST.name,
    addedAt: new Date(),
    addedByUid: "e2e",
  });
});

test.afterAll(async () => {
  await purge();
  await deleteScoped(members().doc(HOST.uid));
});

async function ensureContact(createdByUid: string, name: string): Promise<string> {
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
    agencyId,
    subAccountId,
    createdByUid: opts.createdByUid,
    status: opts.status,
    source: opts.source,
    bookingPageSlug: opts.bookingPageSlug ?? null,
    // Every fixture event belongs to HOST - never "shared busy". See the
    // file-level comment.
    assignedToUid: HOST.uid,
    assignedToName: HOST.name,
    hostUids: [HOST.uid],
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
  const { pageXSlug, pageYSlug } = await ensureBookingStatusSeed();

  const ownerSnap = await adminDb().doc(`agencies/${agencyId}`).get();
  const uid = ownerSnap.data()?.ownerUid as string;
  const stamp = Date.now();

  const contactUpcoming = await ensureContact(uid, `${RUN_TITLE_PREFIX}Upcoming ${stamp}`);
  const contactCancelled = await ensureContact(uid, `${RUN_TITLE_PREFIX}Cancelled ${stamp}`);
  const contactManual = await ensureContact(uid, `${RUN_TITLE_PREFIX}Manual ${stamp}`);
  const contactCancelable = await ensureContact(uid, `${RUN_TITLE_PREFIX}Cancelable ${stamp}`);
  const contactPast = await ensureContact(uid, `${RUN_TITLE_PREFIX}Past ${stamp}`);

  const titleUpcoming = `${RUN_TITLE_PREFIX}Upcoming Booking ${stamp}`;
  const titleCancelled = `${RUN_TITLE_PREFIX}Cancelled Booking ${stamp}`;
  const titleManual = `${RUN_TITLE_PREFIX}Manual Meeting ${stamp}`;
  const titleCancelable = `${RUN_TITLE_PREFIX}Cancelable Booking ${stamp}`;
  const titlePast = `${RUN_TITLE_PREFIX}Past Booking ${stamp}`;

  const upcomingEventId = await createEvent({
    createdByUid: uid,
    contactId: contactUpcoming,
    title: titleUpcoming,
    status: "scheduled",
    startAt: at("09:00"),
    bookingPageSlug: pageXSlug,
    source: "booking_page",
  });
  await createEvent({
    createdByUid: uid,
    contactId: contactCancelled,
    title: titleCancelled,
    status: "cancelled",
    startAt: at("09:30"),
    bookingPageSlug: pageYSlug,
    source: "booking_page",
  });
  await createEvent({
    createdByUid: uid,
    contactId: contactManual,
    title: titleManual,
    status: "scheduled",
    startAt: at("10:00"),
    source: "manual",
  });
  const cancelableEventId = await createEvent({
    createdByUid: uid,
    contactId: contactCancelable,
    title: titleCancelable,
    status: "scheduled",
    startAt: at("10:30"),
    bookingPageSlug: pageXSlug,
    source: "booking_page",
  });
  // Genuinely in the past (not "tomorrow") — HIGH: completed/no_show are
  // only offered once startAt has passed, so the status-flip step below
  // needs a real past booking (just past, so a burst of runs can't push it
  // out of the newest-200 past window the list loads), not the future "titleUpcoming" one.
  const pastEventId = await createEvent({
    createdByUid: uid,
    contactId: contactPast,
    title: titlePast,
    status: "scheduled",
    startAt: new Date(Date.now() - 5 * 60_000),
    bookingPageSlug: pageXSlug,
    source: "booking_page",
  });

  await page.goto(`/sa/${subAccountId}/calendar/appointments`);
  const searchBox = page.getByPlaceholder("Search by title or contact…");

  // The fixture tenant accumulates events across e2e runs, so the table can
  // exceed the page size - scope every tab/filter assertion below to just
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

  await page.screenshot({
    path: "docs/parity/evidence/sp3/f-appointments/upcoming-tab.png",
    fullPage: true,
  });

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
  await searchBox.fill(`${RUN_TITLE_PREFIX}Manual ${stamp}`);
  await expect(page.getByText(titleManual, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(titleUpcoming, { exact: true })).toHaveCount(0);

  // --- HIGH: a future booking's row menu offers no completed/no-show ---
  // (only Cancel — completed/no_show fire a workflow trigger and free the
  // slot, irreversibly, so a default-tab misclick on tomorrow's booking
  // must not be able to do that).
  await searchBox.fill(String(stamp));
  const upcomingRowForMenuCheck = page.locator("tr").filter({ hasText: titleUpcoming });
  await expect(upcomingRowForMenuCheck).toBeVisible({ timeout: 15_000 });
  await upcomingRowForMenuCheck.getByRole("button").last().click();
  await expect(page.getByRole("menuitem", { name: "Mark completed" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Mark no-show" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Cancel" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Confirms there was never a way to flip it: still exactly as seeded.
  const upcomingUnchanged = await adminDb().doc(`events/${upcomingEventId}`).get();
  expect(upcomingUnchanged.data()?.status).toBe("scheduled");

  // --- H1: a manual event's row menu offers no status actions ----------
  const manualRow = page.locator("tr").filter({ hasText: titleManual });
  await expect(manualRow).toBeVisible({ timeout: 15_000 });
  await manualRow.getByRole("button").last().click();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Mark completed" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Mark no-show" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Cancel" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // --- H2: Cancel confirms through an in-app AlertDialog, not confirm() -
  const cancelableRow = page.locator("tr").filter({ hasText: titleCancelable });
  await expect(cancelableRow).toBeVisible({ timeout: 15_000 });
  await cancelableRow.getByRole("button").last().click();
  await page.getByRole("menuitem", { name: "Cancel" }).click();
  const alertDialog = page.getByRole("alertdialog");
  await expect(alertDialog).toBeVisible({ timeout: 5_000 });
  await expect(alertDialog.getByText("Cancel this booking?")).toBeVisible();
  await expect(
    alertDialog.getByText("The visitor is notified by email."),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/parity/evidence/sp3/f-appointments/cancel-alertdialog.png",
    fullPage: true,
  });

  // Dismissing leaves the booking untouched.
  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  const untouched = await adminDb().doc(`events/${cancelableEventId}`).get();
  expect(untouched.data()?.status).toBe("scheduled");

  // Confirming actually cancels it.
  await cancelableRow.getByRole("button").last().click();
  await page.getByRole("menuitem", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await expect(cancelableRow.getByText("Cancelled", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(
      async () => (await adminDb().doc(`events/${cancelableEventId}`).get()).data()?.status,
      { timeout: 15_000 },
    )
    .toBe("cancelled");

  // --- row-menu status change (on a PAST booking — see HIGH above) -----
  // On the All tab (not Upcoming): marking the booking "completed" makes
  // it stop occupying a slot, so it would drop OUT of the Upcoming tab the
  // moment the status flips - the row itself would vanish rather than
  // showing the updated badge in place. All never filters by status, so
  // the row stays put and we can watch its badge change. (It also never
  // appeared in Upcoming to begin with, since its startAt has passed.)
  await page.getByRole("tab", { name: /^All/ }).click();
  await searchBox.fill(String(stamp));
  const pastRow = page.locator("tr").filter({ hasText: titlePast });
  await expect(pastRow).toBeVisible({ timeout: 15_000 });
  await pastRow.getByRole("button").last().click();
  await page.getByRole("menuitem", { name: "Mark completed" }).click();

  await expect(pastRow.getByText("Showed", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(
      async () => (await adminDb().doc(`events/${pastEventId}`).get()).data()?.status,
      { timeout: 15_000 },
    )
    .toBe("completed");
});

// Firestore's Listen stream can sit silent for ~30 s after a write. Rows must
// show the server-confirmed status from the mark-status response, not wait for
// the snapshot delta. Holds (never aborts) the Listen channel.
async function stallFirestoreListen(page: import("@playwright/test").Page) {
  // The initial snapshot is in. Hold every NEW Listen request (stall, never
  // abort), then cut the open stream with a brief offline blip so the SDK has
  // to reconnect into the held requests: nothing more arrives from Firestore.
  // Routing alone is not enough - the open stream is one long response that a
  // route installed afterwards never sees.
  await page.route(
    /firestore\.googleapis\.com\/google\.firestore\.v1\.Firestore\/Listen\/channel/,
    () => new Promise(() => {}),
  );
  await page.context().setOffline(true);
  await page.context().setOffline(false);
}

async function seedStallBooking(label: string, startAt: Date) {
  const { pageXSlug } = await ensureBookingStatusSeed();
  const ownerSnap = await adminDb().doc(`agencies/${agencyId}`).get();
  const uid = ownerSnap.data()?.ownerUid as string;
  const stamp = Date.now();
  const contactId = await ensureContact(uid, `${RUN_TITLE_PREFIX}${label} ${stamp}`);
  const title = `${RUN_TITLE_PREFIX}${label} Booking ${stamp}`;
  const eventId = await createEvent({
    createdByUid: uid,
    contactId,
    title,
    status: "scheduled",
    startAt,
    bookingPageSlug: pageXSlug,
    source: "booking_page",
  });
  return { stamp, title, eventId };
}

async function openAllTabRow(page: import("@playwright/test").Page, stamp: number, title: string) {
  await page.goto(`/sa/${subAccountId}/calendar/appointments`);
  await page.getByRole("tab", { name: /^All/ }).click();
  await page.getByPlaceholder("Search by title or contact…").fill(String(stamp));
  const row = page.locator("tr").filter({ hasText: title });
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

async function expectDocStatus(eventId: string, status: string) {
  await expect
    .poll(async () => (await adminDb().doc(`events/${eventId}`).get()).data()?.status, {
      timeout: 15_000,
    })
    .toBe(status);
}

test("a cancelled row reads Cancelled without waiting for the Firestore delta", async ({
  page,
}) => {
  const { stamp, title, eventId } = await seedStallBooking("Stall", at("11:00"));
  const row = await openAllTabRow(page, stamp, title);
  await stallFirestoreListen(page);

  await row.getByRole("button").last().click();
  await page.getByRole("menuitem", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Cancel booking" }).click();

  await expect(row.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expectDocStatus(eventId, "cancelled");
});

// The Edit dialog opened from the row menu has its own actions panel; its
// confirmed status change must reach the list the same way.
test("a status changed from the Edit dialog reads on the row without the Firestore delta", async ({
  page,
}) => {
  const { stamp, title, eventId } = await seedStallBooking(
    "StallDialog",
    new Date(Date.now() - 5 * 60_000),
  );
  const row = await openAllTabRow(page, stamp, title);
  await stallFirestoreListen(page);

  await row.getByRole("button").last().click();
  await page.getByRole("menuitem", { name: /^(Edit|Reschedule)$/ }).click();
  await page.getByRole("button", { name: "Mark attended" }).click();
  await page.keyboard.press("Escape");

  await expect(row.getByText("Showed", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expectDocStatus(eventId, "completed");
});

// An override must not outlive its minute: with the Listen stream dead the row
// falls back to the snapshot's (stale) status once it expires.
test("a status override expires after a minute instead of masking the row", async ({
  page,
}) => {
  const { stamp, title, eventId } = await seedStallBooking("StallTtl", at("11:30"));
  await page.clock.install();
  const row = await openAllTabRow(page, stamp, title);
  await stallFirestoreListen(page);

  await row.getByRole("button").last().click();
  await page.getByRole("menuitem", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await expect(row.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expectDocStatus(eventId, "cancelled");

  await page.clock.fastForward(61_000);
  await expect(row.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 5_000 });
});

// The Firestore delta can land BEFORE the mark-status response. An override
// created after that snapshot must not then treat a later correction back to
// the old status as a stale snapshot.
test("a delta that beats the response does not leave an override masking a later change", async ({
  page,
}) => {
  const { stamp, title, eventId } = await seedStallBooking("DeltaFirst", at("12:00"));
  const row = await openAllTabRow(page, stamp, title);

  await page.route(/\/api\/events\/by-id\/[^/]+\/mark-status/, async (route) => {
    const response = await route.fetch(); // the write is done server-side
    // Hold the response until the snapshot has already shown the change.
    await expect(row.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 20_000 });
    await route.fulfill({ response });
  });
  await row.getByRole("button").last().click();
  await page.getByRole("menuitem", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Cancel booking" }).click();
  // The toast ("Cancelled. Visitor notified..." / "Cancelled, but ...") only
  // shows once the response has been handled; the row badge is exactly
  // "Cancelled" and does not match.
  await expect(page.getByText(/^Cancelled[.,]/)).toBeVisible({ timeout: 20_000 });
  await expectDocStatus(eventId, "cancelled");

  // Someone else puts it back: the row must follow, not stay "Cancelled".
  await adminDb().doc(`events/${eventId}`).update({ status: "scheduled" });
  await expect(row.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 20_000 });
});
