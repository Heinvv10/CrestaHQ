import { expect, test, type Page } from "@playwright/test";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { deleteScoped } from "../lib/guard";

/**
 * SP3 calendar types, end to end: pages created through the type picker,
 * then a visitor on the public page for each type — who a booking goes to,
 * what a busy host hides, how class seats fill, how a service sizes the
 * slots, and a team booking rescheduled into a time only ANOTHER host is
 * busy for (the reschedule route used to refuse it).
 *
 * Every page opens tomorrow (UTC) 21:00–24:00 only, with 30-min slots and no
 * minimum notice, and the browser runs in UTC — so "9:00 PM" is always a
 * real, bookable slot. Evening, because a hostless page is blocked by ANY
 * event in the sub-account and other specs book the shared fixture in
 * business hours. Hosts are two seeded fixture members.
 */

test.use({ timezoneId: "UTC", locale: "en-US" });

const PREFIX = "e2e-cal-";
const HOST_A = { uid: "e2e-cal-host-a", name: "E2E Cal Host A" };
const HOST_B = { uid: "e2e-cal-host-b", name: "E2E Cal Host B" };

const env = readEnv();
const sa = env.E2E_SUBACCOUNT_ID;
const stamp = Date.now();

const now = new Date();
const tomorrow = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
);
const at = (hhmm: string) =>
  new Date(`${tomorrow.toISOString().slice(0, 10)}T${hhmm}:00Z`);
const time = (label: string) => new RegExp(`^${label.replace(" ", "\\s")}`);

function members() {
  return adminDb().collection(`subAccounts/${sa}/subAccountMembers`);
}

async function seedPage(slug: string, over: Record<string, unknown>) {
  await adminDb()
    .doc(`subAccounts/${sa}/bookingPages/${slug}`)
    .set({
      id: slug,
      slug,
      name: `E2E Cal ${slug}`,
      description: "",
      status: "published",
      durationMinutes: 30,
      bufferMinutes: 0,
      workingHours: [
        { dayOfWeek: tomorrow.getUTCDay(), startMinute: 1260, endMinute: 1440 },
      ],
      timezone: "UTC",
      visibleDays: 2,
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

/** A manual calendar entry for one host (or shared when uid is null). */
async function seedBusy(start: string, end: string, host: typeof HOST_A | null) {
  await adminDb()
    .collection("events")
    .add({
      title: "E2E Cal busy",
      startAt: Timestamp.fromDate(at(start)),
      endAt: Timestamp.fromDate(at(end)),
      contactId: null,
      location: "",
      notes: "",
      agencyId: env.E2E_AGENCY_ID,
      subAccountId: sa,
      createdByUid: "e2e",
      territoryId: "global",
      status: "scheduled",
      source: "manual",
      assignedToUid: host?.uid ?? null,
      assignedToName: host?.name ?? null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
}

async function pageEvents(slug: string) {
  const snap = await adminDb()
    .collection("events")
    .where("subAccountId", "==", sa)
    .where("bookingPageSlug", "==", slug)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>);
}

/** Every event and page this spec made, in this or an earlier crashed run. */
async function purge() {
  const events = await adminDb().collection("events").where("subAccountId", "==", sa).get();
  for (const d of events.docs) {
    const e = d.data();
    const slug = typeof e.bookingPageSlug === "string" ? e.bookingPageSlug : "";
    if (slug.startsWith(PREFIX) || e.title === "E2E Cal busy") await deleteScoped(d.ref);
  }
  const pages = await adminDb().collection(`subAccounts/${sa}/bookingPages`).get();
  for (const d of pages.docs) {
    if (d.id.startsWith(PREFIX)) await deleteScoped(d.ref);
  }
}

async function bookOnPublicPage(page: Page, slot: string) {
  await page.getByRole("button", { name: time(slot) }).click();
  await page.locator("#b-name").fill(`E2E Cal Visitor ${stamp}`);
  await page.locator("#b-email").fill(`e2e-cal-${stamp}@example.com`);
  await page.locator("#b-phone").fill("+27600000000");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByText("You're booked.")).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  await purge();
  for (const h of [HOST_A, HOST_B]) {
    await members().doc(h.uid).set({
      uid: h.uid,
      subAccountId: sa,
      agencyId: env.E2E_AGENCY_ID,
      role: "collaborator",
      status: "active",
      email: `${h.uid}@example.com`,
      displayName: h.name,
      addedAt: new Date(),
      addedByUid: "e2e",
    });
  }
});

test.afterEach(purge);

test.afterAll(async () => {
  await purge();
  for (const h of [HOST_A, HOST_B]) await deleteScoped(members().doc(h.uid));
});

test("the type picker creates a page of each type, badged in the list", async ({ page }) => {
  const types = [
    ["personal", "Personal", []],
    ["round_robin", "Round robin", [HOST_A]],
    ["class", "Class", []],
    ["collective", "Collective", [HOST_A, HOST_B]],
    ["service", "Service", []],
  ] as const;

  for (const [type, label, hosts] of types) {
    const slug = `${PREFIX}${type.replace("_", "-")}-${stamp}`;
    await page.goto(`/sa/${sa}/booking/new`);
    await page.locator(`[data-calendar-type="${type}"]`).click();
    await page.locator("#name").fill(`E2E Cal ${label} ${stamp}`);
    await page.locator("#slug").fill(slug);
    for (const h of hosts) await page.getByLabel(h.name).check();
    await page.getByRole("button", { name: "Create page" }).click();
    await expect(page).toHaveURL(new RegExp(`/booking/${slug}$`), { timeout: 30_000 });

    const doc = await adminDb().doc(`subAccounts/${sa}/bookingPages/${slug}`).get();
    expect(doc.data()?.calendarType).toBe(type);
    expect((doc.data()?.hosts ?? []).map((h: { uid: string }) => h.uid)).toEqual(
      hosts.map((h) => h.uid),
    );
  }

  await page.goto(`/sa/${sa}/booking`);
  for (const [, label] of types) {
    const card = page.getByRole("listitem").filter({ hasText: `E2E Cal ${label} ${stamp}` });
    await expect(card.getByTestId("calendar-type-badge")).toHaveText(label, { timeout: 30_000 });
  }
});

test("round robin, optimize for availability: the high-priority host gets it", async ({ page }) => {
  const slug = `${PREFIX}rr-${stamp}`;
  await seedPage(slug, {
    calendarType: "round_robin",
    distribution: "availability",
    // Page order would pick A under equal distribution; priority must win.
    hosts: [
      { ...HOST_A, priority: 1 },
      { ...HOST_B, priority: 3 },
    ],
  });
  await page.goto(`/b/${sa}/${slug}`);
  await bookOnPublicPage(page, "9:00 PM");
  await expect.poll(async () => (await pageEvents(slug))[0]?.assignedToUid).toBe(HOST_B.uid);
});

test("collective: a time one host is busy for is not offered", async ({ page }) => {
  const slug = `${PREFIX}col-${stamp}`;
  await seedPage(slug, { calendarType: "collective", hosts: [HOST_A, HOST_B] });
  await seedBusy("21:00", "21:30", HOST_B);

  await page.goto(`/b/${sa}/${slug}`);
  await expect(page.getByRole("button", { name: time("9:30 PM") })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: time("9:00 PM") })).toHaveCount(0);

  await bookOnPublicPage(page, "9:30 PM");
  await expect.poll(async () => (await pageEvents(slug))[0]?.hostUids).toEqual([
    HOST_A.uid,
    HOST_B.uid,
  ]);
});

test("class: seats count down per booking, then the time is full", async ({ page }) => {
  const slug = `${PREFIX}class-${stamp}`;
  await seedPage(slug, { calendarType: "class", seatsPerSlot: 2 });
  const nine = page.getByRole("button", { name: time("9:00 PM") });

  await page.goto(`/b/${sa}/${slug}`);
  await expect(nine).toContainText("2 seats left", { timeout: 30_000 });
  await bookOnPublicPage(page, "9:00 PM");

  await page.goto(`/b/${sa}/${slug}`);
  await expect(nine).toContainText("1 seat left", { timeout: 30_000 });
  await bookOnPublicPage(page, "9:00 PM");

  await page.goto(`/b/${sa}/${slug}`);
  await expect(page.getByRole("button", { name: time("9:30 PM") })).toContainText("2 seats left", {
    timeout: 30_000,
  });
  await expect(nine).toHaveCount(0);
  expect(await pageEvents(slug)).toHaveLength(2);
});

test("service: the picked service sizes the slots and is stamped on the booking", async ({ page }) => {
  const slug = `${PREFIX}svc-${stamp}`;
  await seedPage(slug, {
    calendarType: "service",
    services: [
      { id: "cut", name: "E2E Cut", durationMinutes: 60, description: null },
      { id: "trim", name: "E2E Trim", durationMinutes: 30, description: null },
    ],
  });

  await page.goto(`/b/${sa}/${slug}`);
  await page.getByRole("button", { name: /^E2E Cut/ }).click();
  await expect(page.getByRole("button", { name: time("10:00 PM") })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: time("9:30 PM") })).toHaveCount(0);

  await page.getByRole("button", { name: /^E2E Trim/ }).click();
  await expect(page.getByRole("button", { name: time("9:30 PM") })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: /^E2E Cut/ }).click();
  await bookOnPublicPage(page, "10:00 PM");
  await expect.poll(async () => (await pageEvents(slug))[0]?.serviceId).toBe("cut");
  const [ev] = await pageEvents(slug);
  expect((ev.endAt as Timestamp).toDate().toISOString()).toBe(at("23:00").toISOString());
});

test("a team booking reschedules into a time only another host is busy for", async ({ page }) => {
  const slug = `${PREFIX}team-${stamp}`;
  // A legacy team page — no calendarType — is round robin.
  await seedPage(slug, { hosts: [HOST_A, HOST_B] });
  await seedBusy("22:00", "22:30", HOST_B);

  // Bob is busier, so the booking goes to Ann.
  const res = await page.request.post(`/api/booking/${sa}/${slug}/book`, {
    data: {
      slot: { startAt: at("21:00").toISOString(), endAt: at("21:30").toISOString() },
      name: `E2E Cal Visitor ${stamp}`,
      email: `e2e-cal-${stamp}@example.com`,
      phone: "+27600000000",
    },
  });
  expect(res.status()).toBe(200);
  const { publicEventUrl, eventId } = (await res.json()) as { publicEventUrl: string; eventId: string };
  expect((await pageEvents(slug))[0].assignedToUid).toBe(HOST_A.uid);

  await page.goto(publicEventUrl);
  await page.getByRole("button", { name: "Reschedule" }).click();
  await page.getByRole("button", { name: time("10:00 PM") }).click();
  await page.getByRole("button", { name: "Confirm new time" }).click();
  await expect(page.getByText(/Rescheduled\./)).toBeVisible({ timeout: 30_000 });

  const moved = await adminDb().doc(`events/${eventId}`).get();
  expect((moved.data()?.startAt as Timestamp).toDate().toISOString()).toBe(at("22:00").toISOString());
  expect(moved.data()?.assignedToUid).toBe(HOST_A.uid);
});

test("a hostless booking on a page that has since gained hosts can't move onto a host's booking", async ({ page }) => {
  const slug = `${PREFIX}grew-${stamp}`;
  // Booked while the page was hostless, so the event carries no host.
  await seedPage(slug, {});
  const res = await page.request.post(`/api/booking/${sa}/${slug}/book`, {
    data: {
      slot: { startAt: at("21:00").toISOString(), endAt: at("21:30").toISOString() },
      name: `E2E Cal Visitor ${stamp}`,
      email: `e2e-cal-${stamp}@example.com`,
      phone: "+27600000000",
    },
  });
  expect(res.status()).toBe(200);
  const { publicEventUrl, eventId } = (await res.json()) as { publicEventUrl: string; eventId: string };
  expect((await pageEvents(slug))[0].assignedToUid).toBeNull();

  // Now the page has hosts, and Bob is busy at 22:00 while Ann is free.
  await adminDb().doc(`subAccounts/${sa}/bookingPages/${slug}`).update({ hosts: [HOST_A, HOST_B] });
  await seedBusy("22:00", "22:30", HOST_B);

  await page.goto(publicEventUrl);
  await page.getByRole("button", { name: "Reschedule" }).click();
  await expect(page.getByRole("button", { name: time("10:30 PM") })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: time("10:00 PM") })).toHaveCount(0);

  // The route refuses it too, not only the view. Posted from the page, as
  // its own reschedule button does.
  const token = new URL(publicEventUrl).pathname.split("/").pop();
  const status = await page.evaluate(
    async ({ token, slot }) =>
      (
        await fetch(`/api/events/${token}/reschedule`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slot }),
          redirect: "manual",
        })
      ).status,
    { token, slot: { startAt: at("22:00").toISOString(), endAt: at("22:30").toISOString() } },
  );
  expect(status).toBe(409);
  const ev = await adminDb().doc(`events/${eventId}`).get();
  expect((ev.data()?.startAt as Timestamp).toDate().toISOString()).toBe(at("21:00").toISOString());
});

test("a pre-SP3 team page saves its meeting distribution from the editor", async ({ page }) => {
  const slug = `${PREFIX}legacy-${stamp}`;
  // No calendarType: the editor shows it as round robin.
  await seedPage(slug, { hosts: [HOST_A, HOST_B] });

  await page.goto(`/sa/${sa}/booking/${slug}`);
  await page.getByLabel("Optimize for availability").check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

  const doc = await adminDb().doc(`subAccounts/${sa}/bookingPages/${slug}`).get();
  expect(doc.data()).toMatchObject({ calendarType: "round_robin", distribution: "availability" });
});
