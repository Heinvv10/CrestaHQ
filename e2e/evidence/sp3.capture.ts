import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { baseURL, FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { at, day, EVERY_DAY, shot, thirdPartySiteHtml, toTop, ymd, zoom } from "./sp3.helpers";

/**
 * SP3 browser evidence (not a gate): seeds what each screenshot needs on the
 * E2E fixture PRIMARY sub-account, saves 1440×900 PNGs under
 * docs/parity/evidence/sp3/, then deletes everything it created and checks
 * nothing is left. Every event it writes belongs to one of its own pages
 * (bookingPageSlug "e2e-evd-*") — no shared/hostless calendar entries.
 */

test.use({ viewport: { width: 1440, height: 900 }, timezoneId: "UTC", locale: "en-US" });
test.describe.configure({ mode: "serial" });

const PREFIX = "e2e-evd-";
const TITLE = "E2E Evidence";
const env = readEnv();
const sa = env.E2E_SUBACCOUNT_ID;
const HOST_A = { uid: "e2e-evd-host-a", name: "Ava Mokoena" };
const HOST_B = { uid: "e2e-evd-host-b", name: "Ben Naidoo" };
const slug = (s: string) => `${PREFIX}${s}`;

const subRef = () => adminDb().doc(`subAccounts/${sa}`);
const members = () => subRef().collection("subAccountMembers");
let ownerUid = "";
let priorGcalGate: unknown;
const contactIds: string[] = [];
const workflowIds: string[] = [];

async function seedPage(s: string, name: string, over: Record<string, unknown>) {
  await subRef()
    .collection("bookingPages")
    .doc(slug(s))
    .set({
      id: slug(s), slug: slug(s), name, description: "", status: "published",
      durationMinutes: 30, bufferMinutes: 0, workingHours: EVERY_DAY(540, 1020), timezone: "UTC",
      visibleDays: 14, minNoticeHours: 0, maxPerDay: null, intakeFields: [], logoUrl: null,
      accentColor: null, meetingUrl: null, confirmationMessage: "", remindersEnabled: false,
      reminderOffsetsMinutes: [], payment: null, territoryId: "global", defaultTerritoryId: null,
      agencyId: env.E2E_AGENCY_ID, subAccountId: sa, createdByUid: ownerUid,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      ...over,
    });
}

async function seedContact(name: string): Promise<string> {
  const ref = await adminDb().collection("contacts").add({
    name, email: "", phone: "", company: "", address: "", source: "e2e-fixture", tags: [],
    pipelineStage: null, attribution: null, agencyId: env.E2E_AGENCY_ID, subAccountId: sa,
    createdByUid: ownerUid, emailOptedOut: false, smsOptedOut: false, territoryId: "global",
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  contactIds.push(ref.id);
  return ref.id;
}

/** A booking on one of this script's pages (never a shared calendar entry). */
async function seedBooking(pageSlug: string, start: Date, over: Record<string, unknown> = {}) {
  const ref = adminDb().collection("events").doc();
  await ref.set({
    id: ref.id, title: `${TITLE} booking`, startAt: Timestamp.fromDate(start),
    endAt: Timestamp.fromDate(new Date(start.getTime() + 30 * 60_000)), contactId: null,
    location: "", notes: "", agencyId: env.E2E_AGENCY_ID, subAccountId: sa, createdByUid: "booking-page",
    territoryId: "global", status: "scheduled", source: "booking_page", bookingPageSlug: pageSlug,
    assignedToUid: null, assignedToName: null,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    ...over,
  });
  return ref.id;
}

async function purge() {
  await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
  const events = await adminDb().collection("events").where("subAccountId", "==", sa).get();
  for (const d of events.docs) {
    const e = d.data();
    if (String(e.bookingPageSlug ?? "").startsWith(PREFIX) || String(e.title ?? "").startsWith(TITLE)) {
      await deleteScoped(d.ref);
    }
  }
  const pages = await subRef().collection("bookingPages").get();
  for (const d of pages.docs) if (d.id.startsWith(PREFIX)) await deleteScoped(d.ref);
  const wfs = await adminDb().collection("workflows").where("subAccountId", "==", sa).get();
  for (const d of wfs.docs) if (String(d.data().name ?? "").startsWith(TITLE)) await deleteScoped(d.ref);
  const contacts = await adminDb().collection("contacts").where("subAccountId", "==", sa).get();
  for (const d of contacts.docs) if (String(d.data().name ?? "").startsWith(TITLE)) await deleteScoped(d.ref);
  for (const h of [HOST_A, HOST_B]) await deleteScoped(members().doc(h.uid));
  if (ownerUid) {
    // Private docs carry no subAccountId; their parent was asserted above.
    await subRef().collection("private").doc(`googleCalendar_${ownerUid}`).delete();
    await subRef().collection("private").doc(`googleCalendarFake_${ownerUid}`).delete();
  }
}

test.beforeAll(async () => {
  await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
  ownerUid = (await adminDb().doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()?.ownerUid;
  expect(ownerUid).toBeTruthy();
  priorGcalGate = (await subRef().get()).data()?.googleCalendarEnabledByAgency;
  await purge();
  for (const h of [HOST_A, HOST_B]) {
    await members().doc(h.uid).set({
      uid: h.uid, subAccountId: sa, agencyId: env.E2E_AGENCY_ID, role: "collaborator", status: "active",
      email: `${h.uid}@example.invalid`, displayName: h.name, addedAt: new Date(), addedByUid: "e2e",
    });
  }
  await seedPage("team", "Discovery call (team)", {
    calendarType: "round_robin", distribution: "availability",
    hosts: [{ ...HOST_A, priority: 3 }, { ...HOST_B, priority: 1 }],
  });
  await seedPage("personal", "Strategy session", { calendarType: "personal", hosts: [{ ...HOST_A }] });
  await seedPage("collective", "Partner review", { calendarType: "collective", hosts: [HOST_A, HOST_B] });
  await seedPage("class", "Morning yoga class", { calendarType: "class", seatsPerSlot: 8, workingHours: EVERY_DAY(540, 660) });
  await seedPage("service", "Salon appointments", {
    calendarType: "service",
    services: [
      { id: "svc_haircut", name: "Haircut", durationMinutes: 60, description: "Wash, cut and style." },
      { id: "svc_trim", name: "Beard trim", durationMinutes: 30, description: null },
      { id: "svc_colour", name: "Colour", durationMinutes: 90, description: "Full colour with toner." },
    ],
  });
  await seedPage("rules", "Consultation", {
    calendarType: "round_robin",
    bufferBeforeMinutes: 10, bufferMinutes: 15, slotIntervalMinutes: 15,
    dateOverrides: [
      { date: ymd(day(3)), ranges: [] },
      { date: ymd(day(5)), ranges: [{ startMinute: 780, endMinute: 900 }] },
    ],
    hosts: [
      { ...HOST_A, dateOverrides: [{ date: ymd(day(4)), ranges: [{ startMinute: 600, endMinute: 720 }] }] },
      HOST_B,
    ],
  });
  // Today closed, tomorrow 13:00–14:00 only, then the weekly 09:00–17:00.
  await seedPage("override", "Site visit", {
    dateOverrides: [
      { date: ymd(day(0)), ranges: [] },
      { date: ymd(day(1)), ranges: [{ startMinute: 780, endMinute: 840 }] },
    ],
  });
});

test.afterAll(async () => {
  await purge();
  await subRef().update({
    googleCalendarEnabledByAgency: priorGcalGate === undefined ? FieldValue.delete() : priorGcalGate,
  });
  // Nothing this script made may outlive it.
  const events = await adminDb().collection("events").where("subAccountId", "==", sa).get();
  const left = events.docs.filter((d) => {
    const e = d.data();
    return String(e.bookingPageSlug ?? "").startsWith(PREFIX) || String(e.title ?? "").startsWith(TITLE);
  });
  const pages = (await subRef().collection("bookingPages").get()).docs.filter((d) => d.id.startsWith(PREFIX));
  const hosts = await Promise.all([HOST_A, HOST_B].map((h) => members().doc(h.uid).get()));
  expect({ events: left.length, pages: pages.length, hosts: hosts.filter((h) => h.exists).length }).toEqual({
    events: 0,
    pages: 0,
    hosts: 0,
  });
});

test("k-types", async ({ page }) => {
  await page.goto(`/sa/${sa}/booking/new`);
  await expect(page.getByText("Choose calendar type")).toBeVisible({ timeout: 30_000 });
  await shot(page, "k-types/01-type-picker.png");

  await page.goto(`/sa/${sa}/booking`);
  await expect(page.getByRole("link", { name: "Salon appointments" })).toBeVisible({ timeout: 30_000 });
  await zoom(page, 0.7);
  await shot(page, "k-types/02-list-type-badges.png");

  await page.goto(`/b/${sa}/${slug("service")}`);
  await page.getByRole("button", { name: /^Haircut/ }).click({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /^\d{1,2}:\d{2}\s(AM|PM)/ }).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "k-types/03-public-service-picker.png");

  // Three attendees already in the first class slot → "5 seats left".
  const res = await page.request.get(`/api/booking/${sa}/${slug("class")}/availability`);
  const first = new Date(((await res.json()).slots as { startAt: string }[])[0].startAt);
  for (let i = 0; i < 3; i++) await seedBooking(slug("class"), first);
  await page.goto(`/b/${sa}/${slug("class")}`);
  await expect(page.getByText("5 seats left")).toBeVisible({ timeout: 30_000 });
  await shot(page, "k-types/04-public-class-seats-left.png");

  await page.goto(`/sa/${sa}/booking/${slug("team")}`);
  await expect(page.locator("#calendarType")).toBeVisible({ timeout: 30_000 });
  await toTop(page.getByText("Meeting distribution"));
  await expect(page.locator(`#priority-${HOST_A.uid}`)).toHaveValue("3");
  await shot(page, "k-types/05-round-robin-distribution-priority.png");
  await toTop(page.getByRole("heading", { name: "Hosts / team" }));
  await shot(page, "k-types/05b-round-robin-host-priorities.png");
});

test("a-availability", async ({ page }) => {
  await page.goto(`/sa/${sa}/booking/${slug("rules")}`);
  await expect(page.locator("#slotInterval")).toHaveValue("15", { timeout: 30_000 });
  await zoom(page, 0.6);
  await toTop(page.getByRole("heading", { name: "Slot rules" }));
  await shot(page, "a-availability/01-editor-buffers-interval-date-hours.png");
  await zoom(page, 1);
  await toTop(page.getByRole("group", { name: `Date-specific hours for ${HOST_A.name}` }));
  await shot(page, "a-availability/01b-editor-host-date-hours.png");

  await page.goto(`/b/${sa}/${slug("override")}`);
  await expect(page.getByRole("button", { name: /^1:00\sPM/ })).toBeVisible({ timeout: 30_000 });
  await shot(page, "a-availability/02-public-date-override.png");
});

test("s-status", async ({ page }) => {
  const contactId = await seedContact(`${TITLE} Jane Smith`);
  await seedBooking(slug("team"), new Date(Date.now() - 2 * 3600_000), {
    title: `Discovery call (team) — ${TITLE} Jane Smith`, contactId,
    assignedToUid: HOST_A.uid, assignedToName: HOST_A.name,
    rescheduleCount: 1, rescheduledAt: Timestamp.fromDate(new Date(Date.now() - 86_400_000)),
  });
  await page.goto(`/sa/${sa}/booking/${slug("team")}/bookings`);
  await page.getByRole("button", { name: "Past" }).click({ timeout: 30_000 });
  await page.locator("li").filter({ hasText: `${TITLE} Jane Smith` }).click({ timeout: 30_000 });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Rescheduled")).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByRole("button", { name: "Mark no-show" })).toBeVisible();
  await shot(page, "s-status/01-event-dialog-status-rescheduled.png");
  await page.keyboard.press("Escape");

  const wf = await adminDb().collection("workflows").add({
    subAccountId: sa, agencyId: env.E2E_AGENCY_ID, createdByUid: ownerUid,
    name: `${TITLE} — follow up a no-show`, status: "draft",
    trigger: { type: "booking.no_show", filters: { all: [], match: "all" }, bookingPageSlug: slug("team") },
    reentry: "every_time", startNodeId: "tag",
    nodes: { tag: { id: "tag", type: "add_tag", config: { tag: "no-show" }, next: null } },
    stats: { enrolled: 0, completed: 0 },
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  workflowIds.push(wf.id);
  await page.goto(`/sa/${sa}/workflows/${wf.id}`);
  await expect(page.getByText("When this happens")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("select").filter({ hasText: "Any booking page" })).toHaveValue(slug("team"), { timeout: 30_000 });
  await shot(page, "s-status/02-workflow-trigger-no-show-page-filter.png");
});

test("g-gcal", async ({ page }) => {
  await subRef().update({ googleCalendarEnabledByAgency: true });
  await page.goto(`/sa/${sa}/dashboard/settings`);
  const card = page.getByTestId("gcal-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("gcal-connect").click();
  await expect(page.getByTestId("gcal-connected")).toContainText("Connected as", { timeout: 30_000 });
  await expect(page.getByText("Google Calendar connected.")).toBeHidden({ timeout: 15_000 });
  await page.getByTestId("gcal-card").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot(page, "g-gcal/01-settings-google-calendar-connected.png");

  const contactId = await seedContact(`${TITLE} Sam Peters`);
  await seedBooking(slug("team"), at(day(2), "10:00"), {
    title: `Discovery call (team) — ${TITLE} Sam Peters`, contactId,
    assignedToUid: HOST_A.uid, assignedToName: HOST_A.name,
    googleSyncError: { message: "Couldn't add this booking to Ava Mokoena's Google Calendar (the calendar refused the request).", at: Timestamp.now() },
  });
  await page.goto(`/sa/${sa}/booking/${slug("team")}/bookings`);
  await page.locator("li").filter({ hasText: `${TITLE} Sam Peters` }).click({ timeout: 30_000 });
  await expect(page.getByTestId("google-sync-error")).toBeVisible({ timeout: 15_000 });
  await shot(page, "g-gcal/02-event-dialog-not-synced-retry.png");
  await page.keyboard.press("Escape");
});

test("w-widget", async ({ page, browser }) => {
  await page.goto(`/sa/${sa}/booking/${slug("service")}`);
  await page.getByRole("button", { name: "Embed" }).click({ timeout: 30_000 });
  await expect(page.getByRole("dialog").getByText("Embed this booking page")).toBeVisible();
  await shot(page, "w-widget/01-embed-dialog-snippets.png");

  // A third-party site on its own loopback origin embeds the widget.
  const APP = baseURL();
  const html = thirdPartySiteHtml(APP, `${sa}/${slug("service")}`);
  const site: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  try {
    const anon = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "UTC", locale: "en-US" });
    const visitor = await anon.newPage();
    await visitor.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}/`);
    const frame = visitor.frameLocator("iframe");
    await expect(frame.getByRole("button", { name: /^Haircut/ })).toBeVisible({ timeout: 30_000 });
    await shot(visitor, "w-widget/02-third-party-site-embedded-widget.png");
    await anon.close();
  } finally {
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
});
