import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";

/**
 * SP3 PR (d) — Google Calendar sync, G1–G4, against this PR's build.
 *
 * The app runs GCAL_PROVIDER=fake (fenced to loopback + the fixture agency):
 * "Connect" skips Google and lands on the real /api/google/callback, and the
 * member's "Google calendar" is `private/googleCalendarFake_{uid}` — which
 * this spec seeds with busy time, reads back for pushed bookings, and revokes.
 * Everything else — signed state + purpose routing, token storage, the busy
 * loader in the availability and book routes, the push after book/cancel,
 * fail-open on a revoked grant — is the production code path.
 *
 * Writes only to the fixture PRIMARY sub-account, identity-asserted first.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GCAL_PROVIDER=fake, which a deployed target refuses by design");

const SLUG = "e2e-gcal-sync";
const env = () => readEnv();
const primaryRef = () => adminDb().doc(`subAccounts/${env().E2E_SUBACCOUNT_ID}`);
const guard = () => assertFixtureSubAccount(env().E2E_SUBACCOUNT_ID, FIXTURE_PRIMARY_NAME);

let ownerUid = "";
let priorGate: unknown;
const createdEvents: string[] = [];

const privateDoc = (id: string) => primaryRef().collection("private").doc(id);
const fakeCalendar = () => privateDoc(`googleCalendarFake_${ownerUid}`);
const connection = () => privateDoc(`googleCalendar_${ownerUid}`);

/** A weekday-agnostic slot three days out, UTC (the page's timezone). */
function slot(hour: number, minute = 0): { startAt: string; endAt: string } {
  const d = new Date();
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 3, hour, minute));
  return { startAt: start.toISOString(), endAt: new Date(start.getTime() + 30 * 60_000).toISOString() };
}

async function offered(request: APIRequestContext): Promise<string[]> {
  const day = slot(0).startAt;
  const to = new Date(Date.parse(day) + 24 * 3600_000).toISOString();
  const res = await request.get(
    `/api/booking/${env().E2E_SUBACCOUNT_ID}/${SLUG}/availability?from=${encodeURIComponent(day)}&to=${encodeURIComponent(to)}`,
  );
  expect(res.status()).toBe(200);
  return ((await res.json()).slots as Array<{ startAt: string }>).map((s) => s.startAt);
}

async function fakeEvents(): Promise<Array<Record<string, unknown>>> {
  return ((await fakeCalendar().get()).data()?.events ?? []) as Array<Record<string, unknown>>;
}

async function clearGcal(): Promise<void> {
  await guard();
  // The private docs carry no subAccountId; their parent was asserted above.
  await connection().delete();
  await fakeCalendar().delete();
  await deleteScoped(primaryRef().collection("bookingPages").doc(SLUG));
  for (const id of createdEvents) await deleteScoped(adminDb().collection("events").doc(id));
}

test.beforeAll(async () => {
  await guard();
  ownerUid = (await adminDb().doc(`agencies/${env().E2E_AGENCY_ID}`).get()).data()?.ownerUid;
  expect(ownerUid).toBeTruthy();
  priorGate = (await primaryRef().get()).data()?.googleCalendarEnabledByAgency;
  await clearGcal();
  await primaryRef().update({ googleCalendarEnabledByAgency: true });
  // A one-host (team-mode) page open 08:00–18:00 UTC every day.
  await primaryRef().collection("bookingPages").doc(SLUG).set({
    id: SLUG, slug: SLUG, name: "E2E Google Calendar", description: "", status: "published",
    durationMinutes: 30, bufferMinutes: 0, timezone: "UTC", visibleDays: 14, minNoticeHours: 0, maxPerDay: null,
    workingHours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startMinute: 480, endMinute: 1080 })),
    intakeFields: [], hosts: [{ uid: ownerUid, name: "E2E Host" }], logoUrl: null, accentColor: null,
    meetingUrl: null, confirmationMessage: "", remindersEnabled: false, reminderOffsetsMinutes: [], payment: null,
    territoryId: "global", defaultTerritoryId: null,
    agencyId: env().E2E_AGENCY_ID, subAccountId: env().E2E_SUBACCOUNT_ID, createdByUid: ownerUid,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
});

test.afterAll(async () => {
  await clearGcal();
  await primaryRef().update({
    googleCalendarEnabledByAgency: priorGate === undefined ? FieldValue.delete() : priorGate,
  });
});

async function openSettings(page: Page) {
  await page.goto(`/sa/${env().E2E_SUBACCOUNT_ID}/dashboard/settings`);
  await expect(page.getByTestId("gcal-card")).toBeVisible({ timeout: 30_000 });
}

test("a member connects Google Calendar; busy blocks slots, bookings push and cancel, a revoked grant fails open", async ({
  page,
  request,
}) => {
  // --- G1: connect through the real callback (fake consent).
  await openSettings(page);
  const callback = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/google/callback", { timeout: 30_000 });
  await page.getByTestId("gcal-connect").click();
  const res = await callback;
  expect(res.status()).toBe(307);
  expect(new URL(res.headers()["location"] ?? "", res.url()).searchParams.get("gcal")).toBe("connected");
  await expect(page.getByTestId("gcal-connected")).toContainText("Connected as fixture-host@example.invalid", { timeout: 30_000 });
  expect((await connection().get()).data()).toMatchObject({ uid: ownerUid, status: "connected" });

  // --- G2: Google busy during an otherwise free slot removes it — only it.
  const busySlot = slot(10);
  const before = await offered(request);
  expect(before).toContain(busySlot.startAt);
  expect(before).toContain(slot(10, 30).startAt);
  await guard();
  await fakeCalendar().set(
    { events: [{ id: "fixture-busy-1", status: "confirmed", summary: "Dentist", start: { dateTime: busySlot.startAt }, end: { dateTime: busySlot.endAt } }] },
    { merge: true },
  );
  const during = await offered(request);
  expect(during).not.toContain(busySlot.startAt);
  expect(during).toContain(slot(10, 30).startAt);

  // --- The book route re-verifies against Google busy too: the busy slot is a 409.
  const book = (s: { startAt: string; endAt: string }) =>
    request.post(`/api/booking/${env().E2E_SUBACCOUNT_ID}/${SLUG}/book`, {
      data: { slot: s, name: "E2E Gcal Booker", email: `e2e-gcal-${Date.now()}@example.invalid`, phone: "+27100000000" },
    });
  expect((await book(busySlot)).status()).toBe(409);

  // --- G3: a booking lands in the host's Google calendar, tagged as ours.
  const booked = await book(slot(11));
  expect(booked.status()).toBe(200);
  const { eventId, publicEventUrl } = (await booked.json()) as { eventId: string; publicEventUrl: string };
  createdEvents.push(eventId);
  const pushed = (await fakeEvents()).find(
    (e) => (e.extendedProperties as { private?: { leadstackEventId?: string } } | undefined)?.private?.leadstackEventId === eventId,
  );
  expect(pushed).toMatchObject({ start: { dateTime: slot(11).startAt }, end: { dateTime: slot(11).endAt } });
  const stored = (await adminDb().collection("events").doc(eventId).get()).data();
  expect(stored?.googleEventIds).toEqual({ [ownerUid]: pushed?.id });

  // --- Cancel through the manage link: the Google copy is deleted.
  await page.goto(new URL(publicEventUrl).pathname);
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await page.getByRole("button", { name: "Yes, cancel" }).click();
  await expect(page.getByText("This booking has been cancelled.")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await fakeEvents()).some((e) => e.id === pushed?.id), { timeout: 30_000 }).toBe(false);
  expect(await offered(request)).toContain(slot(11).startAt);

  // --- G4: the grant is revoked at Google. Slots are still offered (fail
  // open — the Google busy slot comes back), and the card says Reconnect.
  await guard();
  await fakeCalendar().set({ revoked: true }, { merge: true });
  expect(await offered(request)).toContain(busySlot.startAt);
  expect((await connection().get()).data()).toMatchObject({ status: "revoked", lastError: expect.stringContaining("Reconnect") });
  await openSettings(page);
  await expect(page.getByTestId("gcal-revoked")).toContainText("Reconnect to restore it", { timeout: 30_000 });
  await expect(page.getByTestId("gcal-reconnect")).toBeVisible();
});
