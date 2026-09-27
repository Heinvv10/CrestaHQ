import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./admin";
import { FIXTURE_PRIMARY_NAME, appUrl, readEnv } from "./env";
import { assertFixtureSubAccount, deleteScoped } from "./guard";
import { signQStashBody } from "./qstash";

/**
 * Google Business Profile sync fixtures for the E2E specs — fixture PRIMARY
 * only. Every admin-SDK write is preceded by the fixture identity assertion;
 * every delete of a doc that carries tenant anchors goes through
 * deleteScoped. The app runs GBP_PROVIDER=fake (fenced to the fixture
 * agency), so the "Google" these specs sync from is the fake provider reading
 * `private/gbpFakeScenario`.
 */

export const ACCOUNT = "accounts/e2e-fixture-group";
export const LOC_A = "locations/e2e-velo-gqeberha";
/** The second fixture location — an EXTRA listing in the multi-listing specs. */
export const LOC_B = "locations/e2e-velo-gqeberha-north";
const SCOPE = "https://www.googleapis.com/auth/business.manage";
export const TRANSLATED =
  "(Translated by Google) Fixture review: the connection is okay.\n\n(Original)\nFixture-resensie: die verbinding is okay.";

export const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
export const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);
const guard = () => assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);

export type Scenario = {
  revoked?: boolean;
  accounts: unknown[];
  locations: Record<string, unknown[]>;
  reviews: Record<string, { averageRating: number | null; totalReviewCount: number | null; reviews: Array<Record<string, unknown>> }>;
};

/** The fake's built-in default (fake-scenario.ts), written out so a spec can change it. */
function review(id: string, star: number, comment: string | null, day: number, opts: { anonymous?: boolean; reply?: string; loc?: string } = {}) {
  const d = String(day).padStart(2, "0");
  return {
    name: `${ACCOUNT}/${opts.loc ?? LOC_A}/reviews/${id}`,
    reviewId: id,
    reviewer: { displayName: opts.anonymous ? "" : `Fixture Reviewer ${id}`, profilePhotoUrl: null, isAnonymous: !!opts.anonymous },
    starRating: star,
    comment,
    createTime: `2026-08-${d}T09:00:00Z`,
    updateTime: `2026-08-${d}T09:00:00Z`,
    reply: opts.reply ? { comment: opts.reply, updateTime: `2026-08-${d}T12:00:00Z` } : null,
  };
}

export function defaultScenario(): Scenario {
  return {
    accounts: [{ name: ACCOUNT, accountName: "E2E Fixture Group", type: "LOCATION_GROUP" }],
    locations: {
      [ACCOUNT]: [
        { name: LOC_A, title: "Velo Test Fibre — Gqeberha", address: "1 Fixture Road, Gqeberha, 6001", websiteUri: null, placeId: "fake-place-gqeberha", mapsUri: null, newReviewUri: null },
      ],
    },
    reviews: {
      [LOC_A]: {
        averageRating: 3.6,
        totalReviewCount: 7,
        reviews: [
          review("fake-r7", 5, "Fixture review: installed on the day promised.", 27, { reply: "Thank you from the fixture team." }),
          review("fake-r6", 2, "Fixture review: technician arrived late.", 24),
          review("fake-r5", 3, TRANSLATED, 21),
          review("fake-r4", 5, "Fixture review: fast and friendly.", 18, { anonymous: true }),
          review("fake-r3", 4, null, 15, { reply: "Thanks for the stars, fixture reviewer." }),
          review("fake-r2", 1, "Fixture review: no signal for a week. Not happy.", 12),
          review("fake-r1", 5, "  Fixture review with leading and trailing spaces.  ", 9),
        ],
      },
    },
  };
}

const LOC_B_LOCATION = {
  name: LOC_B, title: "Velo Test Fibre — Gqeberha North", address: "9 Fixture Avenue, Gqeberha North, 6100", websiteUri: null,
  placeId: "fake-place-gqeberha-north", mapsUri: null, newReviewUri: null,
};

/** The default scenario plus the second location, LOC_B, with two reviews of its own. */
export function twoListingScenario(): Scenario {
  const s = defaultScenario();
  s.locations[ACCOUNT].push(LOC_B_LOCATION);
  s.reviews[LOC_B] = {
    averageRating: 4.5,
    totalReviewCount: 2,
    reviews: [review("fake-b2", 5, "Fixture review B: great service north.", 26, { loc: LOC_B }), review("fake-b1", 4, null, 20, { loc: LOC_B })],
  };
  return s;
}

export async function setScenario(s: Scenario): Promise<void> {
  await guard();
  await primaryRef().collection("private").doc("gbpFakeScenario").set(s);
}

/** Remove every GBP trace on the fixture primary: connection, listing, cache, runs, scenario, widget, auto-reply state. */
export async function clearGbp(): Promise<void> {
  await guard();
  const ref = primaryRef();
  // The private docs carry no subAccountId; their parent was asserted above.
  for (const id of ["googleConnection", "gbpFakeScenario", "gbpSyncState", "autoReplyLease", "autoReplyUsage"]) {
    await ref.collection("private").doc(id).delete();
  }
  // Each extra listing's own sync state (private/gbpSyncState_{locId}).
  for (const doc of (await ref.collection("private").get()).docs) {
    if (doc.id.startsWith("gbpSyncState_")) await doc.ref.delete();
  }
  // autoReplyNever / autoReplyDismissed deliberately outlive the review cache
  // in the app; a spec's fixture reviews must not leave them to the next run.
  for (const col of ["gbpReviews", "gbpSyncRuns", "gbpEvents", "gbpReplyAttempts", "autoReplyNever", "autoReplyDismissed"]) {
    const snap = await ref.collection(col).get();
    for (const doc of snap.docs) await deleteScoped(doc.ref);
  }
  // The public widget is top-level (gbpWidgets/{publicId}), anchored like any tenant doc.
  const widgets = await adminDb().collection("gbpWidgets").where("subAccountId", "==", primaryId()).get();
  for (const doc of widgets.docs) await deleteScoped(doc.ref);
  await ref.update({
    googleConnectionMeta: FieldValue.delete(),
    googleListing: FieldValue.delete(),
    googleExtraListings: FieldValue.delete(),
    googleLocationNames: FieldValue.delete(),
    gbpSummary: FieldValue.delete(),
    gbpSummaries: FieldValue.delete(),
    gbpWidgetMeta: FieldValue.delete(),
    // A crashed auto-reply spec must not leave auto-reply on for later specs.
    reviewsAutoReply: FieldValue.delete(),
  });
}

/**
 * A live fake connection with the first fixture location selected — as PR 1's
 * flow leaves it; `extras` also connects LOC_B as an extra listing.
 */
export async function seedConnectedListing(opts: { extras?: boolean } = {}): Promise<void> {
  await guard();
  const sa = primaryId();
  const ownerUid = (await adminDb().doc(`agencies/${readEnv().E2E_AGENCY_ID}`).get()).data()?.ownerUid ?? null;
  await primaryRef().collection("private").doc("googleConnection").set({
    refreshToken: `fake-refresh:${sa}:9001`,
    accessToken: `fake-access:${sa}:1`,
    accessTokenExpiresAt: Date.now() + 3_600_000,
    scopes: [SCOPE],
  });
  await primaryRef().update({
    googleConnectionMeta: { connected: true, email: null, scopes: [SCOPE], connectedAt: new Date(), connectedByUid: ownerUid },
    googleListing: {
      accountName: ACCOUNT, accountDisplayName: "E2E Fixture Group", locationName: LOC_A,
      title: "Velo Test Fibre — Gqeberha", address: "1 Fixture Road, Gqeberha, 6001", websiteUri: null,
      placeId: "fake-place-gqeberha", mapsUri: null, newReviewUri: null, selectedAt: new Date(), selectedByUid: ownerUid,
    },
    ...(opts.extras
      ? {
          googleExtraListings: [{
            accountName: ACCOUNT, accountDisplayName: "E2E Fixture Group", locationName: LOC_B, title: LOC_B_LOCATION.title,
            address: LOC_B_LOCATION.address, websiteUri: null, placeId: LOC_B_LOCATION.placeId, mapsUri: null, newReviewUri: null,
            selectedAt: new Date(), selectedByUid: ownerUid,
          }],
          googleLocationNames: [LOC_A, LOC_B],
        }
      : {}),
  });
}

/**
 * Sync now is limited to one a minute per sub-account; a spec that clicks it
 * twice lifts the cooldown in between rather than sleeping a minute.
 */
export async function resetManualCooldown(): Promise<void> {
  await guard();
  await primaryRef().collection("private").doc("gbpSyncState").set({ lastManualAt: null }, { merge: true });
}

/** The scheduled path: POST the cron exactly as QStash would, signed. */
export async function runCron(request: APIRequestContext): Promise<{ processed: number; byStatus: Record<string, number> }> {
  const body = "{}";
  const res = await request.post("/api/cron/gbp-sync", {
    headers: { "upstash-signature": signQStashBody(appUrl("/api/cron/gbp-sync"), body), "content-type": "application/json" },
    data: body,
  });
  expect(res.status()).toBe(200);
  return res.json();
}

export async function reviewDocs() {
  return (await primaryRef().collection("gbpReviews").get()).docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown> & { id: string });
}

export async function latestRun(): Promise<Record<string, unknown>> {
  const snap = await primaryRef().collection("gbpSyncRuns").orderBy("finishedAt", "desc").limit(1).get();
  return snap.docs[0]?.data() ?? {};
}

export async function summary(): Promise<Record<string, unknown>> {
  return ((await primaryRef().get()).data()?.gbpSummary ?? {}) as Record<string, unknown>;
}

/** Common setup/teardown: gate on, clean slate, a connected listing, the default scenario. */
export function gbpLifecycle(test: { beforeAll: (fn: () => Promise<void>) => void; afterAll: (fn: () => Promise<void>) => void }) {
  let priorGate: unknown;
  test.beforeAll(async () => {
    await guard();
    priorGate = (await primaryRef().get()).data()?.googleEnabledByAgency;
    await clearGbp();
    await primaryRef().update({ googleEnabledByAgency: true });
    await seedConnectedListing();
    await setScenario(defaultScenario());
  });
  test.afterAll(async () => {
    await clearGbp();
    await guard();
    await primaryRef().update({
      googleEnabledByAgency: priorGate === undefined ? FieldValue.delete() : priorGate,
    });
  });
}

/**
 * The default scenario with reviewer names that carry no "fake-" marker, so a
 * public-feed spec can deep-scan the body for internal identifiers (the review
 * ids and Place ID still say "fake-" — and must never be served).
 */
export function publicScenario(): Scenario {
  const s = defaultScenario();
  for (const r of s.reviews[LOC_A].reviews) {
    const reviewer = r.reviewer as { displayName: string };
    if (reviewer.displayName) reviewer.displayName = reviewer.displayName.replace("fake-", "No. ");
  }
  return s;
}

/**
 * Create (or update) the primary's widget through the real admin route, from
 * INSIDE the signed-in page: the session cookie is Secure, which the page
 * sends to 127.0.0.1 but Playwright's API request context does not. The page
 * must already be on the app.
 */
export async function putWidget(page: Page, config: Record<string, unknown>): Promise<string> {
  const res = await page.evaluate(
    async ({ url, body }) => {
      const r = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as { widget?: { publicId: string } } };
    },
    { url: `/api/sub-accounts/${primaryId()}/gbp/widget`, body: config },
  );
  expect(res.status).toBe(200);
  return res.body.widget!.publicId;
}

export const feedPath = (publicId: string) => `/api/public/gbp/feed/${publicId}`;

/** Move the summary's last successful sync `hours` into the past (admin write, fixture-guarded). */
export async function ageLastSuccess(hours: number): Promise<void> {
  await guard();
  await primaryRef().update({ "gbpSummary.lastSuccessfulSyncAt": new Date(Date.now() - hours * 3600_000) });
}

/** Every reply call the fake received for the primary, in order (failed ones too). */
export async function replyCalls(): Promise<Array<{ op: string; reviewName: string }>> {
  const snap = await primaryRef().collection("private").doc("gbpFakeScenario").get();
  return (snap.data()?.calls ?? []) as Array<{ op: string; reviewName: string }>;
}

/** Merge into the primary's stored scenario — keeps the fake's reply state and call log. */
export async function patchScenario(patch: Record<string, unknown>): Promise<void> {
  await guard();
  await primaryRef().collection("private").doc("gbpFakeScenario").set(patch, { merge: true });
}

/** Give the selected listing a Google "write a review" link. */
export async function setListingReviewUri(url: string | null): Promise<void> {
  await guard();
  await primaryRef().update({ "googleListing.newReviewUri": url });
}

/**
 * A same-origin JSON call from INSIDE the signed-in page (the session cookie
 * is Secure: the page sends it to 127.0.0.1, Playwright's API request context
 * does not — see putWidget). The page must already be on the app.
 */
export async function pageFetch(page: Page, url: string, method: string, body?: string) {
  return page.evaluate(
    async ({ url, method, body }) => {
      const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    },
    { url, method, body },
  );
}
