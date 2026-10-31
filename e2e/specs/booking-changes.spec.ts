import { expect, test, type Page } from "@playwright/test";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertWindowsClear } from "../lib/booking-windows";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { runId } from "../lib/run-id";

/**
 * The attendee's own manage link, end to end through booking-changes-service:
 * book on the public API, reschedule from /e (the token rotates, so the old
 * link stops working), then cancel from the same tab — and a repeat cancel
 * still answers ok without changing anything.
 *
 * The page opens 21:00–24:00 UTC four days out, a window no other booking
 * spec uses (a hostless page is blocked by ANY event in the sub-account),
 * and the browser runs in UTC.
 */

test.use({ timezoneId: "UTC", locale: "en-US" });

const BASE_PREFIX = "e2e-chg-";
const PREFIX = `${BASE_PREFIX}${runId()}-`;
const STALE_MS = 6 * 3600_000;
const env = readEnv();
const sa = env.E2E_SUBACCOUNT_ID;
const stamp = Date.now();

const now = new Date();
const DAY = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 4));
const at = (hhmm: string) => new Date(`${DAY.toISOString().slice(0, 10)}T${hhmm}:00Z`);
const time = (label: string) => new RegExp(`^${label.replace(" ", "\\s")}`);

async function seedPage(slug: string) {
  await adminDb()
    .doc(`subAccounts/${sa}/bookingPages/${slug}`)
    .set({
      id: slug,
      slug,
      name: `E2E Changes ${slug}`,
      description: "",
      status: "published",
      durationMinutes: 30,
      bufferMinutes: 0,
      workingHours: [{ dayOfWeek: DAY.getUTCDay(), startMinute: 1260, endMinute: 1440 }],
      timezone: "UTC",
      visibleDays: 6,
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

/** POST from the page, as the /e view's own buttons do. */
async function postFromPage(page: Page, path: string, body?: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
      return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
    },
    { path, body },
  );
}

test.beforeAll(async () => {
  await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
  await purge();
  await assertWindowsClear(
    sa,
    [[at("21:00"), new Date(at("21:00").getTime() + 3 * 3600_000)]],
    (e) => String(e.bookingPageSlug ?? "").startsWith(PREFIX),
  );
});
test.afterAll(purge);

test("book, reschedule from the manage link, then cancel it", async ({ page }) => {
  const slug = `${PREFIX}flow-${stamp}`;
  await seedPage(slug);

  const res = await page.request.post(`/api/booking/${sa}/${slug}/book`, {
    data: {
      slot: { startAt: at("21:00").toISOString(), endAt: at("21:30").toISOString() },
      name: `E2E Changes Visitor ${stamp}`,
      email: `e2e-chg-${stamp}@example.com`,
      phone: "+27600000000",
    },
  });
  expect(res.status()).toBe(200);
  const { publicEventUrl, eventId } = (await res.json()) as { publicEventUrl: string; eventId: string };
  const firstToken = new URL(publicEventUrl).pathname.split("/").pop()!;
  const event = () => adminDb().doc(`events/${eventId}`).get();

  await page.goto(publicEventUrl);
  await page.getByRole("button", { name: "Reschedule" }).click();
  await page.getByRole("button", { name: time("10:00 PM") }).click({ timeout: 30_000 });
  await page.getByRole("button", { name: "Confirm new time" }).click();
  await expect(page.getByText(/Rescheduled\./)).toBeVisible({ timeout: 30_000 });

  const moved = (await event()).data()!;
  expect((moved.startAt as Timestamp).toDate().toISOString()).toBe(at("22:00").toISOString());
  expect(moved).toMatchObject({ status: "scheduled", rescheduleCount: 1, isLong: false });
  // The view swapped its URL to the rotated token; the old link is dead.
  await expect(page).not.toHaveURL(new RegExp(firstToken));
  expect((await postFromPage(page, `/api/events/${firstToken}/cancel`)).status).toBe(404);
  expect((await event()).data()?.status).toBe("scheduled");

  await page.getByRole("button", { name: "Cancel booking" }).click();
  await page.getByRole("button", { name: "Yes, cancel" }).click();
  await expect(page.getByText("This booking has been cancelled.")).toBeVisible({ timeout: 30_000 });
  const cancelled = (await event()).data()!;
  expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "by_visitor", cancelledByVisitor: true });

  // A repeat cancel on the live token: ok, and nothing changes.
  const liveToken = new URL(page.url()).pathname.split("/").pop()!;
  const again = await postFromPage(page, `/api/events/${liveToken}/cancel`);
  expect(again).toEqual({ status: 200, json: { ok: true } });
  expect(((await event()).data()?.cancelledAt as Timestamp).toMillis()).toBe(
    (cancelled.cancelledAt as Timestamp).toMillis(),
  );

  // And a cancelled booking can't be moved.
  const moveAgain = await postFromPage(page, `/api/events/${liveToken}/reschedule`, {
    slot: { startAt: at("22:30").toISOString(), endAt: at("23:00").toISOString() },
  });
  expect(moveAgain.status).toBe(409);
});
