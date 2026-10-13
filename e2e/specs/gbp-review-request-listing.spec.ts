import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { FIRESTORE_LISTEN, stallFirestoreListen } from "../lib/firestore-listen";
import { LOC_B, gbpLifecycle, primaryId, primaryRef, seedConnectedListing } from "../lib/gbp";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { FAKE_ACCOUNT_SID, FAKE_AUTH_TOKEN, FAKE_CALLER_NUMBER, FAKE_FROM_NUMBER } from "../lib/missed-call";

/**
 * MULTI_LISTING_V1_PLAN.md PR 5 — a review request for an EXTRA listing, on
 * the fixture PRIMARY with the fenced GBP fake and the fenced fake SMS rail
 * (SMS_PROVIDER=fake, fake Twilio credentials, a Twilio magic test number —
 * nothing reaches a phone; dedicated mode writes one thread row per SMS,
 * which is how the body is read back).
 *
 * The admin adopts LOC_B's own review link on its card on the Google Business
 * page (the main's configured link is untouched), then sends from Reputation
 * → Requests with LOC_B selected: the SMS carries LOC_B's link and not the
 * main's, the log row names LOC_B, and the Requests list shows its title.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake and SMS_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);

const MAIN_URL = "https://g.page/r/e2e-listing-main/review";
const B_URL = "https://review.fixture.example/e2e-gqeberha-north";
const B_KEY = LOC_B.slice("locations/".length);
const STAMP = Date.now();
const CONTACT_NAME = `E2E Listing Requestee ${STAMP}`;
const restore = (v: unknown) => (v === undefined ? FieldValue.delete() : v);

let contactId = "";
let restoreConfigs: { twilioConfig: unknown; googleReviewConfig: unknown } | null = null;

const log = () => primaryRef().collection("reviewRequests");
const reviewConfig = async () => (await primaryRef().get()).data()?.googleReviewConfig as Record<string, unknown> | undefined;
const smsBodies = async () =>
  (await adminDb().collection(`contacts/${contactId}/messages`).get()).docs.map((d) => d.data().body as string);

async function purgeRequests() {
  for (const d of (await log().get()).docs) await deleteScoped(d.ref);
}

test.beforeAll(async () => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  const env = readEnv();
  await seedConnectedListing({ extras: true });
  const data = (await primaryRef().get()).data() ?? {};
  const extras = (data.googleExtraListings ?? []) as Array<Record<string, unknown>>;
  await primaryRef().update({ googleExtraListings: extras.map((l) => (l.locationName === LOC_B ? { ...l, newReviewUri: B_URL } : l)) });
  restoreConfigs = { twilioConfig: data.twilioConfig, googleReviewConfig: data.googleReviewConfig };
  await purgeRequests();
  await primaryRef().update({
    twilioConfig: {
      enabled: true, accountSid: FAKE_ACCOUNT_SID, authToken: FAKE_AUTH_TOKEN, fromNumber: FAKE_FROM_NUMBER,
      whatsappFromNumber: null, whatsappSandbox: false, whatsappInboundWebhookConfigured: false,
      inboundWebhookConfigured: false, lastValidatedAt: null, inboundWebhookSecret: null, missedCall: null,
    },
    googleReviewConfig: {
      enabled: false, reviewUrl: MAIN_URL, channel: "sms", messageTemplate: "", whatsappTemplateId: null,
      cooldownDays: 90, triggerOnQuotePaid: false, triggerOnDealCompleted: false, updatedAt: new Date(),
    },
  });
  const ownerUid = (await adminDb().doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()?.ownerUid ?? null;
  const contact = await adminDb().collection("contacts").add({
    agencyId: env.E2E_AGENCY_ID, subAccountId: primaryId(), createdByUid: ownerUid,
    name: CONTACT_NAME, email: "", phone: FAKE_CALLER_NUMBER, company: "", address: "",
    source: "e2e-fixture", tags: ["e2e-review-request-listing"], pipelineStage: null, attribution: null,
    smsOptedOut: false, territoryId: "global", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  contactId = contact.id;
});

test.afterAll(async () => {
  // Every step runs even if an earlier one throws, and all failures surface.
  const errors: unknown[] = [];
  const step = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      errors.push(err);
    }
  };
  if (contactId) {
    await step(() => deleteScoped(adminDb().doc(`contacts/${contactId}`)));
    await step(() => deleteScoped(adminDb().doc(`conversations/${contactId}`)));
  }
  await step(purgeRequests);
  const configs = restoreConfigs;
  if (configs) {
    await step(async () => {
      await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
      await primaryRef().update({ twilioConfig: restore(configs.twilioConfig), googleReviewConfig: restore(configs.googleReviewConfig) });
    });
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "gbp-review-request-listing teardown: several steps failed");
});

test("an extra listing's adopted link is the one its review request sends", async ({ page }) => {
  // --- Safety before sending: SMS only, to a Twilio magic number, on the fixture primary.
  const contact = (await adminDb().doc(`contacts/${contactId}`).get()).data() ?? {};
  if (contact.subAccountId !== primaryId() || contact.phone !== FAKE_CALLER_NUMBER || (await reviewConfig())?.channel !== "sms") {
    throw new Error("Refusing to run: the requestee is not the fixture's magic-number contact on an SMS config.");
  }

  // --- Adopt LOC_B's own link on its card; the main's link stays.
  await page.goto(`/sa/${primaryId()}/ai-agents/google-business`);
  const card = page.getByTestId("gbp-listing-reviewurl-proposal");
  await expect(card).toHaveAttribute("data-location", LOC_B, { timeout: 30_000 });
  await expect(card).toHaveAttribute("data-state", "proposal_available");
  await expect(card).toContainText(B_URL);
  // The card must show the adopt from the route's 200, not the doc's next snapshot.
  await stallFirestoreListen(page);
  await card.getByTestId("gbp-listing-reviewurl-adopt").click();
  await expect.poll(async () => (await reviewConfig())?.listingUrls, { timeout: 30_000 }).toEqual({ [B_KEY]: B_URL });
  await expect(page.getByTestId("gbp-listing-reviewurl-matches")).toBeVisible({ timeout: 30_000 });
  expect((await reviewConfig())?.reviewUrl).toBe(MAIN_URL);
  await page.unroute(FIRESTORE_LISTEN);

  // --- Send with LOC_B selected, through the real picker and route.
  await page.goto(`/sa/${primaryId()}/reputation/requests`);
  await page.getByTestId("rep-send-open").click({ timeout: 30_000 });
  const dialog = page.getByTestId("rep-send-dialog");
  await expect(dialog.getByTestId("rep-send-listing")).toHaveValue("");
  await dialog.getByTestId("rep-send-listing").selectOption(LOC_B);
  await dialog.getByRole("button", { name: "Pick a contact…" }).click({ timeout: 30_000 });
  await page.getByPlaceholder("Type to filter…").fill(CONTACT_NAME);
  await page.getByRole("option", { name: new RegExp(CONTACT_NAME) }).click();
  await page.getByTestId("rep-send-submit").click();
  await expect(page.getByTestId("rep-send-result")).toHaveText("Review request sent.", { timeout: 30_000 });

  // --- The outbound body carries LOC_B's link, never the main's; the row names LOC_B.
  await expect.poll(smsBodies, { timeout: 30_000 }).toHaveLength(1);
  const [body] = await smsBodies();
  expect(body).toContain(B_URL);
  expect(body).not.toContain(MAIN_URL);
  const rows = (await log().where("contactId", "==", contactId).get()).docs.map((d) => d.data());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ locationName: LOC_B, channel: "sms", source: "dispatcher", status: "sent" });
  expect(rows[0]).not.toHaveProperty("tracked");

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("rep-req-listing")).toHaveText("Velo Test Fibre — Gqeberha North", { timeout: 30_000 });
});
