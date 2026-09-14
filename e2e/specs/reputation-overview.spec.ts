import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, FIXTURE_SECONDARY_NAME, readEnv } from "../lib/env";
import { LOC_A, defaultScenario, gbpLifecycle, pageFetch, primaryId, primaryRef, runCron, setScenario, type Scenario } from "../lib/gbp";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { FAKE_ACCOUNT_SID, FAKE_AUTH_TOKEN, FAKE_CALLER_NUMBER, FAKE_FROM_NUMBER } from "../lib/missed-call";

/**
 * SP5 (a) — Reputation → Overview (ledger N1, V1–V6, V8). On the fixture
 * PRIMARY: the fake provider's seven reviews, re-dated to the last few weeks
 * so the default 90-day range holds them whatever day this runs, synced
 * through the signed cron; two REAL manual review requests through the send
 * route → dispatcher → fenced fake SMS rail (SMS_PROVIDER=fake; fake Twilio
 * credentials, a Twilio magic test number — nothing can reach a phone), each
 * writing a reviewRequests log row. The tiles must equal the numbers computed
 * here from that seeded data. The sidebar entry must lead there, and the
 * SECONDARY fixture (Google gate off) must show the gate-off state with the
 * request half still present.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake and SMS_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);

const DAY = 24 * 3600_000;
const REVIEW_URL = "https://g.page/r/e2e-reputation/review";
const secondaryId = () => readEnv().E2E_SUBACCOUNT_ID_SECONDARY;
const restore = (v: unknown) => (v === undefined ? FieldValue.delete() : v);

/** The default scenario, each review moved to (i*3 + 1) days ago; replies 3h after their review. */
function recentScenario(now: number): Scenario {
  const s = defaultScenario();
  s.reviews[LOC_A].reviews.forEach((r, i) => {
    const created = new Date(now - (i * 3 + 1) * DAY).toISOString();
    Object.assign(r, { createTime: created, updateTime: created });
    const reply = r.reply as { updateTime: string } | null;
    if (reply) reply.updateTime = new Date(Date.parse(created) + 3 * 3600_000).toISOString();
  });
  return s;
}

let contactId = "";
/**
 * What setup read BEFORE writing, set only once it has — teardown runs even
 * when beforeAll throws, so it restores only what setup actually changed and
 * never writes a value it did not read (a failed setup must not be masked by
 * a teardown TypeError, nor "restore" a config to undefined).
 */
let restoreConfigs: { twilioConfig: unknown; googleReviewConfig: unknown } | null = null;
let secondaryGateFlipped = false;

async function purgeRequests() {
  const snap = await primaryRef().collection("reviewRequests").get();
  for (const d of snap.docs) await deleteScoped(d.ref);
}

test.beforeAll(async () => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  await assertFixtureSubAccount(secondaryId(), FIXTURE_SECONDARY_NAME);
  const data = (await primaryRef().get()).data() ?? {};
  const prior = { twilioConfig: data.twilioConfig, googleReviewConfig: data.googleReviewConfig };
  const secondaryGate = (await adminDb().doc(`subAccounts/${secondaryId()}`).get()).data()?.googleEnabledByAgency;
  await purgeRequests();
  await setScenario(recentScenario(Date.now()));
  restoreConfigs = prior;
  await primaryRef().update({
    twilioConfig: {
      enabled: true, accountSid: FAKE_ACCOUNT_SID, authToken: FAKE_AUTH_TOKEN, fromNumber: FAKE_FROM_NUMBER,
      whatsappFromNumber: null, whatsappSandbox: false, whatsappInboundWebhookConfigured: false,
      inboundWebhookConfigured: false, lastValidatedAt: null, inboundWebhookSecret: null, missedCall: null,
    },
    googleReviewConfig: {
      enabled: false, reviewUrl: REVIEW_URL, channel: "sms", messageTemplate: "", whatsappTemplateId: null,
      cooldownDays: 90, triggerOnQuotePaid: false, triggerOnDealCompleted: false, updatedAt: new Date(),
    },
  });
  if (secondaryGate === true) {
    secondaryGateFlipped = true;
    await adminDb().doc(`subAccounts/${secondaryId()}`).update({ googleEnabledByAgency: false });
  }
  const ownerUid = (await adminDb().doc(`agencies/${readEnv().E2E_AGENCY_ID}`).get()).data()?.ownerUid ?? null;
  const ref = await adminDb().collection("contacts").add({
    name: "E2E Reputation Requestee", email: "", phone: FAKE_CALLER_NUMBER, company: "", address: "",
    source: "e2e-fixture", tags: ["e2e-reputation"], pipelineStage: null, attribution: null,
    agencyId: readEnv().E2E_AGENCY_ID, subAccountId: primaryId(), createdByUid: ownerUid,
    territoryId: "global", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  contactId = ref.id;
});

test.afterAll(async () => {
  if (contactId) {
    await deleteScoped(adminDb().doc(`contacts/${contactId}`));
    await deleteScoped(adminDb().doc(`conversations/${contactId}`));
  }
  // Each row is checked against the fixture tenant by deleteScoped.
  await purgeRequests();
  if (restoreConfigs) {
    await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
    await primaryRef().update({
      twilioConfig: restore(restoreConfigs.twilioConfig),
      googleReviewConfig: restore(restoreConfigs.googleReviewConfig),
    });
  }
  if (secondaryGateFlipped) {
    await assertFixtureSubAccount(secondaryId(), FIXTURE_SECONDARY_NAME);
    await adminDb().doc(`subAccounts/${secondaryId()}`).update({ googleEnabledByAgency: true });
  }
});

test("the overview's tiles equal the synced reviews and the logged requests", async ({ page, request }) => {
  // --- Safety before sending: SMS only, to a Twilio magic number, on the fixture primary.
  const contact = (await adminDb().doc(`contacts/${contactId}`).get()).data() ?? {};
  const cfg = (await primaryRef().get()).data()?.googleReviewConfig;
  if (contact.subAccountId !== primaryId() || contact.phone !== FAKE_CALLER_NUMBER || cfg?.channel !== "sms") {
    throw new Error("Refusing to run: the requestee is not the fixture's magic-number contact on an SMS config.");
  }

  await runCron(request);
  const reviews = recentScenario(Date.now()).reviews[LOC_A].reviews as Array<{ starRating: number; reply: unknown }>;
  const stars = reviews.map((r) => r.starRating);
  const replied = reviews.filter((r) => r.reply).length;
  const expected = {
    avg: (stars.reduce((a, b) => a + b, 0) / stars.length).toFixed(1),
    count: String(stars.length),
    coverage: `${Math.round((replied / stars.length) * 100)}%`,
    dist: [1, 2, 3, 4, 5].map((s) => stars.filter((x) => x === s).length),
  };

  // --- Two real manual sends through the fenced fake SMS rail.
  await page.goto(`/sa/${primaryId()}/dashboard`);
  for (let i = 0; i < 2; i++) {
    const res = await pageFetch(page, "/api/comms/review-request/send", "POST", JSON.stringify({ contactId }));
    expect(res).toEqual({ status: 200, body: { ok: true, sent: true } });
  }
  const logged = (await primaryRef().collection("reviewRequests").get()).docs.map((d) => d.data());
  expect(logged).toHaveLength(2);
  expect(logged.every((r) => r.contactId === contactId && r.channel === "sms" && r.trigger === "manual")).toBe(true);

  // --- The sidebar entry leads to the overview.
  await page.locator(`a[href="/sa/${primaryId()}/reputation"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/sa/${primaryId()}/reputation$`));
  const overview = page.getByTestId("rep-overview");
  await expect(overview).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("rep-range")).toHaveValue("90d");

  await expect(page.getByTestId("rep-tile-avg-value")).toHaveText(expected.avg, { timeout: 30_000 });
  await expect(page.getByTestId("rep-tile-count-value")).toHaveText(expected.count);
  await expect(page.getByTestId("rep-tile-coverage-value")).toHaveText(expected.coverage);
  await expect(page.getByTestId("rep-tile-reply-time-value")).toHaveText("3 h");
  await expect(page.getByTestId("rep-tile-requests-value")).toHaveText("2");
  for (let s = 1; s <= 5; s++) {
    await expect(page.getByTestId(`rep-distribution-${s}`)).toHaveAttribute("data-count", String(expected.dist[s - 1]));
  }
  await expect(page.getByTestId("rep-response-replied")).toContainText(String(replied));
  await expect(page.getByTestId("rep-requests-channels")).toHaveText("SMS: 2");
  await expect(page.getByTestId("rep-requests-since")).toContainText("Counting since");
  await expect(page.getByTestId("rep-listing")).toContainText("Google shows 3.6 from 7 reviews");
  await expect(page.getByTestId("rep-trend")).toBeVisible();
  for (const item of ["googleConnected", "listingSelected", "reviewLinkConfigured", "requestLogged"]) {
    await expect(page.getByTestId(`rep-checklist-${item}`)).toHaveAttribute("data-done", "true");
  }
  await expect(page.getByTestId("rep-checklist-widgetExists")).toHaveAttribute("data-done", "false");

  // --- The Reviews tab mounts the existing inbox over the same seven reviews.
  await page.getByTestId("rep-tab-reviews").click();
  await expect(page.locator('[data-testid^="gbp-review-fake-"]')).toHaveCount(7, { timeout: 30_000 });
});

test("a sub-account with the Google gate off shows the gate-off state, requests still shown", async ({ page }) => {
  expect((await adminDb().doc(`subAccounts/${secondaryId()}`).get()).data()?.googleEnabledByAgency).not.toBe(true);
  await page.goto(`/sa/${secondaryId()}/reputation`);
  await expect(page.getByTestId("rep-state-gate-off")).toContainText("Google reviews are not enabled for this sub-account", { timeout: 30_000 });
  await expect(page.getByTestId("rep-tile-requests")).toBeVisible();
  await expect(page.getByTestId("rep-tile-avg")).toHaveCount(0);
  await expect(page.getByTestId("rep-checklist")).toBeVisible();
});
