import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";

/**
 * E2E 1 — connect Google Business Profile (fake provider) and select one of
 * two similarly named listings, in a real browser against this PR's build.
 *
 * The app runs with GBP_PROVIDER=fake (fenced to loopback + the fixture
 * agency), so "Connect" skips Google and lands straight on the real callback
 * route. Everything after that — the signed state, the uid binding, the token
 * split, discovery, the server-verified selection and its audit event — is
 * the production code path.
 *
 * Writes only to the fixture PRIMARY sub-account, and asserts that identity
 * before every admin-SDK write.
 */

const NORTH = "locations/e2e-velo-gqeberha-north";
const TOKEN_MARKERS = /fake-refresh|fake-access|refreshToken|accessToken/;

let priorGate: unknown;

// The non-blocking smoke job (e2e-smoke.yml) aims every spec at
// crm.crestahq.com. The fake provider is refused there BY DESIGN (production
// URL, no opt-in), so "Connect" would go to the real Google consent screen.
// Explicit skip on that target only; the blocking ci.yml job always runs it.
test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "needs GBP_PROVIDER=fake, which a deployed target refuses by design",
);

function primaryRef() {
  return adminDb().doc(`subAccounts/${readEnv().E2E_SUBACCOUNT_ID}`);
}

/** Remove every GBP trace this spec can leave. Scope-asserted first. */
async function clearGbpState(): Promise<void> {
  const env = readEnv();
  await assertFixtureSubAccount(env.E2E_SUBACCOUNT_ID, FIXTURE_PRIMARY_NAME);
  const ref = primaryRef();
  // The private docs carry no subAccountId of their own; their parent was
  // asserted to be the fixture primary on the line above.
  await ref.collection("private").doc("googleConnection").delete();
  await ref.collection("private").doc("gbpFakeScenario").delete();
  const events = await ref.collection("gbpEvents").get();
  for (const doc of events.docs) await deleteScoped(doc.ref);
  await ref.update({
    googleConnectionMeta: FieldValue.delete(),
    googleListing: FieldValue.delete(),
  });
}

test.beforeAll(async () => {
  const env = readEnv();
  await assertFixtureSubAccount(env.E2E_SUBACCOUNT_ID, FIXTURE_PRIMARY_NAME);
  priorGate = (await primaryRef().get()).data()?.googleEnabledByAgency;
  await clearGbpState();
  await primaryRef().update({ googleEnabledByAgency: true });
});

test.afterAll(async () => {
  await clearGbpState();
  await primaryRef().update({
    googleEnabledByAgency: priorGate === undefined ? FieldValue.delete() : priorGate,
  });
});

test("an admin connects Google and selects the intended one of two similar listings", async ({
  page,
}) => {
  const env = readEnv();
  const sa = env.E2E_SUBACCOUNT_ID;

  await page.goto(`/sa/${sa}/ai-agents/google-business`);
  await expect(page.getByTestId("gbp-state-disconnected")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("gbp-connect").click();
  await page.waitForURL(new RegExp(`/sa/${sa}/ai-agents/google-business`), { timeout: 30_000 });
  await expect(page.getByTestId("gbp-state-pick")).toBeVisible({ timeout: 30_000 });

  // Both similarly named listings, each with its distinguishing address.
  const first = page.getByTestId("gbp-location-option-0");
  const second = page.getByTestId("gbp-location-option-1");
  await expect(first).toContainText("Velo Test Fibre — Gqeberha", { timeout: 30_000 });
  await expect(first).toContainText("1 Fixture Road, Gqeberha, 6001");
  await expect(first).not.toContainText("North");
  await expect(second).toContainText("Velo Test Fibre — Gqeberha North");
  await expect(second).toContainText("9 Fixture Avenue, Gqeberha North, 6100");

  await second.click();
  await page.getByTestId("gbp-select-listing").click();

  await expect(page.getByTestId("gbp-state-selected")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("gbp-selected-listing")).toContainText("Velo Test Fibre — Gqeberha North");
  await expect(page.getByTestId("gbp-selected-listing")).toContainText("9 Fixture Avenue");

  // --- Storage: tokens only in the locked doc, nothing secret on the member-readable one.
  const secret = (await primaryRef().collection("private").doc("googleConnection").get()).data();
  expect(secret?.refreshToken).toMatch(/^fake-refresh:/);
  expect(secret?.accessToken).toMatch(/^fake-access:/);

  const sub = (await primaryRef().get()).data() ?? {};
  expect(JSON.stringify(sub.googleConnectionMeta)).not.toMatch(TOKEN_MARKERS);
  expect(JSON.stringify(sub.googleListing)).not.toMatch(TOKEN_MARKERS);
  expect(sub.googleConnectionMeta?.connected).toBe(true);
  expect(sub.googleListing?.locationName).toBe(NORTH);

  // --- Audit: the selection is recorded, tenant-anchored, with who did it.
  const ownerUid = (await adminDb().doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()?.ownerUid;
  const events = (await primaryRef().collection("gbpEvents").get()).docs.map((d) => d.data());
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "listing_selected",
      agencyId: env.E2E_AGENCY_ID,
      subAccountId: sa,
      createdByUid: ownerUid,
      locationName: NORTH,
    }),
  );
});
