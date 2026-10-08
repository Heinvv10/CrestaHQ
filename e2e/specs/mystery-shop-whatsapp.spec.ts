import { FieldValue } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { ownerUid } from "../lib/seed";
import { whatsappCloudSecretPath } from "../../src/types/whatsapp-cloud";

/**
 * Prospecting PR 5b: the Reports card's Mystery shop (WhatsApp) through the
 * real server's GET — the channel's availability (sender, template status),
 * the contact's own number, the template text and its hash — and the confirm
 * dialog naming the number.
 *
 * Nothing is ever sent: the POST is intercepted in the browser and answered
 * 202 with a real `sent` shop doc written on the fixture, so the card's status
 * line comes from the real GET. The fixture is put on the Cloud rail with a
 * FAKE connection (no real token: a stray send could only fail at Meta) and an
 * approved template fixture; every field and the connection doc are restored
 * exactly afterwards. Tagged @not-on-prod: e2e-smoke.yml runs the suite
 * against production and skips it.
 */

const sa = () => readEnv().E2E_SUBACCOUNT_ID;
const PHONE = "+27820000001";
const FIELDS = [
  "prospectingEnabledByAgency", "whatsappEnabledByAgency", "whatsappProvider", "whatsappCloudMeta", "whatsappSenders",
  "prospectingMysteryShopTemplates",
] as const;

/** The fixture on the Cloud rail; `connected` decides whether its (fake) connection doc exists. Returns the restore. */
async function onCloudRail(connected: boolean): Promise<() => Promise<void>> {
  await assertFixtureSubAccount(sa(), FIXTURE_PRIMARY_NAME);
  const db = adminDb();
  const saRef = db.doc(`subAccounts/${sa()}`);
  const connRef = db.doc(whatsappCloudSecretPath(sa()));
  const before = (await saRef.get()).data() ?? {};
  const priorConn = (await connRef.get()).data();
  await saRef.update({
    prospectingEnabledByAgency: true,
    whatsappEnabledByAgency: true,
    whatsappProvider: "cloud",
    whatsappCloudMeta: { phoneNumberId: "e2e-mystery-phone", displayPhoneNumber: "+27 60 000 0000", verifiedName: "E2E", connectedAt: new Date(), connectedByUid: "e2e" },
    // No sender registry: the default sender is the Cloud rail above.
    whatsappSenders: FieldValue.delete(),
    prospectingMysteryShopTemplates: FieldValue.delete(),
  });
  if (connected) await connRef.set({ phoneNumberId: "e2e-mystery-phone", wabaId: "e2e-waba", accessToken: "e2e-not-a-token" });
  else await connRef.delete();
  return async () => {
    await assertFixtureSubAccount(sa(), FIXTURE_PRIMARY_NAME);
    await saRef.update(Object.fromEntries(FIELDS.map((f) => [f, before[f] === undefined ? FieldValue.delete() : before[f]])));
    if (priorConn) await connRef.set(priorConn);
    else await connRef.delete();
  };
}

async function seedContact(stamp: number) {
  const env = readEnv();
  return adminDb().collection("contacts").add({
    agencyId: env.E2E_AGENCY_ID, subAccountId: sa(), createdByUid: await ownerUid(env.E2E_AGENCY_ID),
    name: `E2E Mystery WA ${stamp}`, email: "", phone: PHONE, company: `E2E Mystery Plumbing ${stamp}`,
    address: "", city: "Gqeberha", source: "e2e-fixture", tags: ["e2e-mystery-shop"], pipelineStage: null,
    attribution: null, emailOptedOut: false, smsOptedOut: false, whatsappOptedOut: false, territoryId: "global",
    prospecting: { category: "plumber" },
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
}

async function cleanUp(contactRef: FirebaseFirestore.DocumentReference) {
  const shops = await adminDb().collection("mysteryShops").where("subAccountId", "==", sa()).where("contactId", "==", contactRef.id).get();
  for (const d of shops.docs) await deleteScoped(d.ref);
  await deleteScoped(contactRef);
}

test("Mystery shop (WhatsApp): disabled with its reason when no sender is connected @not-on-prod", async ({ page }) => {
  const restore = await onCloudRail(false);
  const contactRef = await seedContact(Date.now());
  try {
    await page.goto(`/sa/${sa()}/contacts/${contactRef.id}`);
    await expect(page.getByTestId("mystery-shop")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("mystery-shop-whatsapp")).toBeDisabled();
    await expect(page.getByTestId("mystery-shop-whatsapp-reason")).toHaveText("WhatsApp: No WhatsApp sender is connected.");
  } finally {
    try {
      await restore();
    } finally {
      await cleanUp(contactRef);
    }
  }
});

test("Mystery shop (WhatsApp): approved template → the dialog names the number, confirm sends, the card shows the shop @not-on-prod", async ({ page }) => {
  const env = readEnv();
  const stamp = Date.now();
  const db = adminDb();
  const restore = await onCloudRail(true);
  const tplRef = db.doc(`subAccounts/${sa()}/whatsappTemplates/e2e-speed-check-${stamp}`);
  const contactRef = await seedContact(stamp);
  const contactId = contactRef.id;
  const posted: unknown[] = [];
  try {
    await tplRef.set({
      agencyId: env.E2E_AGENCY_ID, subAccountId: sa(), createdByUid: "e2e", name: "leadstack_speed_check",
      displayName: "E2E speed check", category: "UTILITY", language: "en",
      body: "Hi, do you offer {{1}} in {{2}}? What's your earliest availability?",
      variables: [
        { position: 1, label: "Service", sampleValue: "plumbing", source: "manual", mergeTag: null },
        { position: 2, label: "Town", sampleValue: "Gqeberha", source: "manual", mergeTag: null },
      ],
      status: "approved", rejectionReason: null, contentSid: null, pollAttempts: 0, lastSyncedAt: null, approvedAt: null,
      registrations: { cloud: { externalId: "e2e-meta-template", status: "approved", rejectionReason: null } },
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });

    await page.route("**/prospecting/mystery-shop", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON() as { target: string };
      posted.push(body);
      // What the route writes on a successful send — on the fixture sub-account only.
      await assertFixtureSubAccount(sa(), FIXTURE_PRIMARY_NAME);
      const shop = await db.collection("mysteryShops").add({
        agencyId: env.E2E_AGENCY_ID, subAccountId: sa(), contactId, reportId: null, channel: "whatsapp",
        target: body.target, targetLabel: body.target, status: "sent", sentAt: new Date(), respondedAt: null,
        responseMs: null, autoReplyAt: null, deliveredAt: new Date(), jobValueCents: 150_000, currency: "ZAR", niche: "plumber",
        enquiryText: "e2e", providerRef: `wamid.e2e-${stamp}`, failure: null, createdByUid: "e2e",
        confirmedAt: new Date(), createdAt: new Date(), usageMonth: "e2e",
      });
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ shopId: shop.id }) });
    });

    await page.goto(`/sa/${sa()}/contacts/${contactId}`);
    const card = page.getByTestId("mystery-shop");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("mystery-shop-whatsapp")).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId("mystery-shop-whatsapp-reason")).toHaveCount(0);

    await page.getByTestId("mystery-shop-whatsapp").click();
    const dialog = page.getByTestId("mystery-shop-confirm");
    await expect(dialog).toContainText("Send a mystery-shop WhatsApp?");
    await expect(dialog.getByTestId("mystery-shop-target")).toHaveText(PHONE);
    await expect(dialog.getByTestId("mystery-shop-enquiry")).toHaveText(
      "Hi, do you offer plumber in Gqeberha? What's your earliest availability?",
    );
    await expect(dialog.getByTestId("mystery-shop-consent-ack")).toHaveCount(0);
    await dialog.getByTestId("mystery-shop-confirm-send").click();
    await expect(card.getByText(new RegExp(`WhatsApp to \\${PHONE} — sent \\d+ (s|m) ago, delivered, waiting for a reply \\(24 h\\)`))).toBeVisible({
      timeout: 30_000,
    });
    expect(posted).toEqual([
      { contactId, channel: "whatsapp", confirm: true, target: PHONE, enquiryHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  } finally {
    try {
      await restore();
    } finally {
      await deleteScoped(tplRef);
      await cleanUp(contactRef);
    }
  }
});
