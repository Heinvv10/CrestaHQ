import { FieldValue } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { ownerUid } from "../lib/seed";

/**
 * Prospecting PR 5a: the Reports card's Mystery shop (email) through the real
 * server — the real GET (channel availability, the contact's own target, the
 * rendered enquiry), the confirm dialog naming the target, and a POST.
 *
 * Nothing is ever sent. The fixture gets public SMTP + mailbox metadata (so
 * the Email channel is offered) but NO private SMTP credentials doc, asserted
 * below: the first POST runs the real route, which refuses with "SMTP is not
 * connected" before any socket and settles the shop `failed`. The second POST
 * is intercepted in the browser — the seam inbox-email-threading.spec.ts
 * uses — and answered with the `sent` shop the route would have written, so
 * the card's status line is driven by the real GET.
 */

const sa = () => readEnv().E2E_SUBACCOUNT_ID;

test("Mystery shop (email): the dialog names the target, confirm sends, the card shows the shop", async ({ page }) => {
  const env = readEnv();
  await assertFixtureSubAccount(sa(), FIXTURE_PRIMARY_NAME);
  const db = adminDb();
  const stamp = Date.now();
  const uid = await ownerUid(env.E2E_AGENCY_ID);
  const target = `e2e-mystery-${stamp}@example.com`;

  // The guard that makes the real POST below safe: no credentials, no send.
  expect((await db.doc(`subAccounts/${sa()}/private/smtpConnection`).get()).exists).toBe(false);

  const saRef = db.doc(`subAccounts/${sa()}`);
  const before = (await saRef.get()).data() ?? {};
  await saRef.update({
    prospectingEnabledByAgency: true,
    emailProvider: "smtp",
    smtpConfig: {
      host: "smtp.e2e.invalid", port: 587, secure: false, username: "e2e",
      fromEmail: "desk@e2e.invalid", fromName: "E2E Desk", verifiedAt: new Date().toISOString(),
    },
    mailboxConfig: {
      host: "imap.e2e.invalid", port: 993, username: "e2e", sentFolder: null,
      verifiedAt: new Date().toISOString(), lastSyncAt: null, lastError: null, enabled: true,
    },
  });

  const contactRef = await db.collection("contacts").add({
    agencyId: env.E2E_AGENCY_ID, subAccountId: sa(), createdByUid: uid,
    name: `E2E Mystery ${stamp}`, email: target, phone: "", company: `E2E Mystery Plumbing ${stamp}`,
    address: "", city: "Gqeberha", source: "e2e-fixture", tags: ["e2e-mystery-shop"], pipelineStage: null,
    attribution: null, emailOptedOut: false, smsOptedOut: false, territoryId: "global",
    prospecting: { category: "plumber" },
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  const contactId = contactRef.id;

  let intercept = false;
  const posted: unknown[] = [];
  await page.route("**/prospecting/mystery-shop", async (route) => {
    if (route.request().method() !== "POST" || !intercept) return route.continue();
    const body = route.request().postDataJSON() as { target: string };
    posted.push(body);
    // What the route writes on a successful send.
    const shop = await db.collection("mysteryShops").add({
      agencyId: env.E2E_AGENCY_ID, subAccountId: sa(), contactId, reportId: null, channel: "email",
      target: body.target, targetLabel: body.target, status: "sent", sentAt: new Date(), respondedAt: null,
      responseMs: null, autoReplyAt: null, jobValueCents: 150_000, currency: "ZAR", niche: "plumber",
      enquiryText: "e2e", providerRef: `<e2e-${stamp}@e2e.invalid>`, failure: null, createdByUid: uid,
      confirmedAt: new Date(), createdAt: new Date(), usageMonth: "e2e",
    });
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ shopId: shop.id }) });
  });

  try {
    await page.goto(`/sa/${sa()}/contacts/${contactId}`);
    const card = page.getByTestId("mystery-shop");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("mystery-shop-whatsapp")).toBeDisabled();
    await expect(page.getByTestId("mystery-shop-whatsapp-reason")).toHaveText("WhatsApp: Not available yet.");

    // 1. The real route: dialog → POST → refused by the missing SMTP credentials → failed.
    await page.getByTestId("mystery-shop-email").click();
    const dialog = page.getByTestId("mystery-shop-confirm");
    await expect(dialog.getByTestId("mystery-shop-target")).toHaveText(target);
    await expect(dialog.getByTestId("mystery-shop-enquiry")).toContainText("Do you do plumber in Gqeberha?");
    await dialog.getByTestId("mystery-shop-confirm-send").click();
    await expect(card.getByText(`Email to ${target} — failed:`)).toBeVisible({ timeout: 30_000 });

    // 2. Intercepted: confirm → the card shows the shop sent and waiting.
    intercept = true;
    await page.getByTestId("mystery-shop-email").click();
    await expect(dialog.getByTestId("mystery-shop-target")).toHaveText(target);
    await dialog.getByTestId("mystery-shop-confirm-send").click();
    await expect(card.getByText(new RegExp(`Email to ${target.replace(/[.]/g, "\\.")} — sent \\d+ (s|m) ago, waiting for a reply \\(24 h\\)`))).toBeVisible({
      timeout: 30_000,
    });
    expect(posted).toEqual([{ contactId, channel: "email", confirm: true, target }]);
  } finally {
    try {
      await saRef.update({
        prospectingEnabledByAgency: before.prospectingEnabledByAgency ?? FieldValue.delete(),
        emailProvider: before.emailProvider ?? FieldValue.delete(),
        smtpConfig: before.smtpConfig ?? FieldValue.delete(),
        mailboxConfig: before.mailboxConfig ?? FieldValue.delete(),
      });
    } finally {
      const shops = await db.collection("mysteryShops").where("subAccountId", "==", sa()).where("contactId", "==", contactId).get();
      for (const d of shops.docs) await deleteScoped(d.ref);
      await deleteScoped(contactRef);
    }
  }
});
