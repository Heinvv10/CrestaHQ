import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { gbpLifecycle, pageFetch, primaryId, primaryRef, setListingReviewUri } from "../lib/gbp";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";

/**
 * E2E 7 — review-request regression. An existing review-request config
 * (https://g.page/r/e2e-existing/review) and a fixture contact whose SMS and
 * WhatsApp are opted out, so NOTHING can reach a phone: the manual send runs
 * the real dispatcher and answers opted_out. The selected listing's own
 * review link is only proposed — the page shows `differs` with both links, a
 * reload changes nothing, and only the admin's click adopts it; a stale
 * compare-and-set is refused.
 *
 * Quote-paid path — proven in vitest, not here (it would need a real send):
 *   src/lib/server/quotes-service.review-request.test.ts
 *     › marking a quote paid asks for a review with trigger quote_paid
 *     › a refused mark-paid asks for nothing
 *   src/lib/reviews/request.test.ts
 *     › sends SMS and reports sent:true when every guard passes (quote_paid)
 *     › refuses quote_paid when only the deal_completed trigger is on
 *   plus the cooldown / opt-out / WhatsApp rail suites in src/lib/reviews/*.test.ts.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);

const EXISTING = "https://g.page/r/e2e-existing/review";
const LISTING_URL = "https://review.fixture.example/e2e-gqeberha";
const ADOPT = () => `/api/sub-accounts/${primaryId()}/google-review/adopt-listing-url`;
const configuredUrl = async () => (await primaryRef().get()).data()?.googleReviewConfig?.reviewUrl;

let contactId = "";
let priorConfig: unknown;

test.beforeAll(async () => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  priorConfig = (await primaryRef().get()).data()?.googleReviewConfig ?? null;
  await setListingReviewUri(LISTING_URL);
  await primaryRef().update({
    googleReviewConfig: {
      enabled: false, reviewUrl: EXISTING, channel: "sms", messageTemplate: "Hi {{firstName}}, a review? {{reviewUrl}}",
      whatsappTemplateId: null, cooldownDays: 30, triggerOnQuotePaid: false, triggerOnDealCompleted: false, updatedAt: new Date(),
    },
  });
  const ownerUid = (await adminDb().doc(`agencies/${readEnv().E2E_AGENCY_ID}`).get()).data()?.ownerUid ?? null;
  const ref = await adminDb().collection("contacts").add({
    name: "E2E Review Request Opted Out", email: "", phone: "+27000000000", company: "", address: "",
    source: "e2e-fixture", tags: ["e2e-review-request"], pipelineStage: null, attribution: null,
    agencyId: readEnv().E2E_AGENCY_ID, subAccountId: primaryId(), createdByUid: ownerUid,
    emailOptedOut: true, smsOptedOut: true, whatsappOptedOut: true, territoryId: "global",
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  contactId = ref.id;
});

test.afterAll(async () => {
  if (contactId) await deleteScoped(adminDb().doc(`contacts/${contactId}`));
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  await primaryRef().update({ googleReviewConfig: priorConfig === null ? FieldValue.delete() : priorConfig });
});

test("review requests keep their rules; the listing's link is proposed, adopted only on a click", async ({ page }) => {
  // --- Safety before acting: this contact can receive nothing, and the config sends SMS only.
  const contact = (await adminDb().doc(`contacts/${contactId}`).get()).data() ?? {};
  if (contact.smsOptedOut !== true || contact.whatsappOptedOut !== true || contact.subAccountId !== primaryId()) {
    throw new Error("Refusing to run: the fixture contact is not opted out of SMS and WhatsApp on the fixture primary.");
  }
  if ((await primaryRef().get()).data()?.googleReviewConfig?.channel !== "sms") {
    throw new Error("Refusing to run: the fixture review-request config is not SMS.");
  }

  // --- The manual request runs the real dispatcher and stops at the opt-out.
  await page.goto(`/sa/${primaryId()}/ai-agents/google-business`);
  const send = await pageFetch(page, "/api/comms/review-request/send", "POST", JSON.stringify({ contactId }));
  expect(send).toEqual({ status: 200, body: { ok: true, sent: false, reason: "opted_out" } });
  expect((await adminDb().doc(`contacts/${contactId}`).get()).data()?.reviewRequestedAt).toBeUndefined();

  // --- The listing's link is proposed next to the configured one; nothing is applied.
  const card = page.getByTestId("gbp-reviewurl-proposal");
  await expect(card).toHaveAttribute("data-state", "differs", { timeout: 30_000 });
  await expect(card).toContainText(EXISTING);
  await expect(card).toContainText(LISTING_URL);
  await page.reload();
  await expect(card).toHaveAttribute("data-state", "differs", { timeout: 30_000 });
  expect(await configuredUrl()).toBe(EXISTING);

  // --- Only the click adopts it.
  await page.getByTestId("gbp-reviewurl-adopt").click();
  await expect.poll(configuredUrl, { timeout: 30_000 }).toBe(LISTING_URL);
  await expect(page.getByTestId("gbp-reviewurl-matches")).toBeVisible({ timeout: 30_000 });

  // --- A compare-and-set on the URL the admin saw before: refused, nothing written.
  const stale = await pageFetch(page, ADOPT(), "POST", JSON.stringify({ expectedCurrentUrl: EXISTING }));
  expect(stale).toMatchObject({ status: 409, body: { code: "changed", currentUrl: LISTING_URL } });
  expect(await configuredUrl()).toBe(LISTING_URL);
});
