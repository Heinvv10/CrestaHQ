import { FieldValue } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";

/**
 * WhatsApp-inbound contacts arrive with `name: ""`. Editing one must not
 * force the operator to invent a name: change only the company, save, and
 * the name stays empty in Firestore while the header titles the contact by
 * its phone. Then create one the same way: phone only, no name.
 */

test("edits a nameless phone-only contact without requiring a name", async ({
  page,
}) => {
  const env = readEnv();
  const stamp = Date.now();
  const phone = `+2782${String(stamp).slice(-7)}`;
  const company = `E2E Nameless Co ${stamp}`;

  const agency = await adminDb().doc(`agencies/${env.E2E_AGENCY_ID}`).get();
  const ref = await adminDb().collection("contacts").add({
    name: "",
    email: "",
    phone,
    company: "",
    address: "",
    source: "whatsapp",
    tags: ["e2e-nameless"],
    pipelineStage: null,
    attribution: null,
    agencyId: env.E2E_AGENCY_ID,
    subAccountId: env.E2E_SUBACCOUNT_ID,
    createdByUid: agency.data()?.ownerUid,
    emailOptedOut: false,
    smsOptedOut: false,
    territoryId: "global",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/contacts/${ref.id}`);
  // The top bar has its own h1 ("Contact") outside <main>; the profile
  // title is the one contact-profile-header.tsx renders inside it.
  const title = page.locator("main h1");
  await expect(title).toHaveText(phone, { timeout: 30_000 });

  await page.getByRole("button", { name: "Edit" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.locator("#c-name")).toHaveValue("");
  await sheet.locator("#c-company").fill(company);
  await sheet.getByRole("button", { name: "Save Changes" }).click();

  await expect(page.getByText(company)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => (await ref.get()).data()?.company,
      { timeout: 15_000 },
    )
    .toBe(company);
  expect((await ref.get()).data()?.name).toBe("");
  await expect(title).toHaveText(phone);

  // --- create: phone only through the UI, no name ------------------------
  // The client validation passing is not enough — POST /api/contacts must
  // accept it too, so assert the doc exists in Firestore with name "".
  const createdPhone = `+2783${String(stamp).slice(-7)}`;
  await page.goto(`/sa/${env.E2E_SUBACCOUNT_ID}/contacts`);
  await page.getByRole("button", { name: "Add Contact" }).first().click();
  const addSheet = page.getByRole("dialog");
  await addSheet.locator("#c-phone").fill(createdPhone);
  await addSheet.getByRole("button", { name: "Add Contact" }).click();

  await expect(page.locator("tr").filter({ hasText: createdPhone })).toBeVisible(
    { timeout: 30_000 },
  );
  const created = await adminDb()
    .collection("contacts")
    .where("subAccountId", "==", env.E2E_SUBACCOUNT_ID)
    .where("phone", "==", createdPhone)
    .limit(1)
    .get();
  expect(created.empty, "phone-only contact was not written").toBe(false);
  expect(created.docs[0].data().name).toBe("");
});
