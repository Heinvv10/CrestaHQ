import { expect, test, type Page } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";

/**
 * Port 1.0.54 C1 — Google Calendar import, against this PR's build, through
 * the real settings API, import engine and Firestore. The app runs
 * GCAL_PROVIDER=fake (fenced to loopback + the fixture agency); the owner's
 * "Google calendar" is `private/googleCalendarFake_{uid}`, and their
 * connection is seeded with fake-bound tokens (connect itself is covered by
 * google-calendar-sync.spec.ts). No UI yet (C2), so calls are in-page fetches
 * with the owner's session.
 *
 * Writes only to the fixture PRIMARY sub-account, identity-asserted first;
 * restores the gate and the allowance, and deletes every doc it made.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GCAL_PROVIDER=fake, which a deployed target refuses by design");

const env = () => readEnv();
const SA = () => env().E2E_SUBACCOUNT_ID;
const primaryRef = () => adminDb().doc(`subAccounts/${SA()}`);
const guard = () => assertFixtureSubAccount(SA(), FIXTURE_PRIMARY_NAME);

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

/** Two days out, UTC, so it is inside the import window wherever CI runs. */
const at = (hour: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 2, hour)).toISOString();
};

async function clearImport(): Promise<void> {
  await guard();
  // The private docs carry no subAccountId; their parent was asserted above.
  await connection().delete();
  await fakeCalendar().delete();
  for (const d of await imports()) await deleteScoped(d.ref);
}

async function api(page: Page, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return page.evaluate(
    async ({ sa, body }) => {
      const res = await fetch(`/api/sub-accounts/${sa}/google-calendar/import`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    },
    { sa: SA(), body },
  );
}

test.beforeAll(async () => {
  await guard();
  ownerUid = (await adminDb().doc(`agencies/${env().E2E_AGENCY_ID}`).get()).data()?.ownerUid;
  expect(ownerUid).toBeTruthy();
  const sub = (await primaryRef().get()).data();
  prior = { gate: sub?.googleCalendarEnabledByAgency, allowed: sub?.calendarImportAllowed };
  await clearImport();
  await primaryRef().update({ googleCalendarEnabledByAgency: true });
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
      { id: "e2e-import-1", status: "confirmed", summary: "Dentist", location: "Main Rd", start: { dateTime: at(9) }, end: { dateTime: at(10) } },
      { id: "e2e-import-free", status: "confirmed", transparency: "transparent", summary: "Lunch", start: { dateTime: at(12) }, end: { dateTime: at(13) } },
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

test("an admin allows import, a member opts in to busy-only, syncs, and opting out removes it", async ({ page, request }) => {
  // The sweep route is public only to a valid QStash signature.
  expect((await request.post("/api/cron/calendar-import", { data: {} })).status()).toBe(401);

  await page.goto(`/sa/${SA()}/dashboard/settings`);
  // Not allowed yet: opting in is refused.
  expect((await api(page, { allowWorkspace: false })).status).toBe(200);
  expect((await api(page, { mode: "busy" })).json.code).toBe("not_allowed");

  expect((await api(page, { allowWorkspace: true })).status).toBe(200);
  expect((await api(page, { mode: "busy" })).status).toBe(200);
  // The mode change already starts a full pass after its response, so a sync
  // asked for straight after can land inside the 60 s full-pass cooldown. Either
  // answer is correct; the poll below proves a pass ran.
  const sync = await api(page, { syncNow: true });
  if (sync.status === 429) {
    expect(sync.json.code).toBe("cooldown");
  } else {
    expect(sync.status).toBe(200);
    expect(sync.json.result).toMatchObject({ ok: true, full: true });
  }

  // Busy time only: the Free event is skipped, the title and place are not stored.
  await expect.poll(async () => (await imports()).length, { timeout: 30_000 }).toBe(1);
  const [doc] = await imports();
  expect(doc.data()).toMatchObject({ title: "Busy", location: "", importMode: "busy", territoryId: "global", status: "scheduled" });
  expect(JSON.stringify(doc.data())).not.toMatch(/Dentist|Main Rd|Lunch/);
  for (const k of ["assignedToUid", "hostUids", "mode", "publicTokenHash", "bookingPageSlug"]) {
    expect(doc.data()).not.toHaveProperty(k);
  }

  // A re-run duplicates nothing (it may also be refused by the same cooldown).
  const rerun = await api(page, { syncNow: true });
  expect([200, 429]).toContain(rerun.status);
  if (rerun.status === 429) expect(rerun.json.code).toBe("cooldown");
  expect(await imports()).toHaveLength(1);

  // Opting out removes it at once.
  expect((await api(page, { mode: "off" })).json).toEqual({ ok: true, removed: 1 });
  expect(await imports()).toHaveLength(0);
});
