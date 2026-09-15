import { FieldValue } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { assertFixtureAgency, deleteScoped } from "../lib/guard";

/**
 * Launchpad (SP13 d), end to end: flip real connection state under the
 * fixture sub-account and see the checklist item — and the overall progress
 * count — move with it. Every mutation goes through Firestore directly
 * (the launchpad page is read-only), and every mutation is restored in
 * `finally` so the fixture sub-account is unchanged for the next run.
 */

test("reads real connection state, not a stored flag", async ({ page }) => {
  const env = readEnv();
  const sa = env.E2E_SUBACCOUNT_ID;
  await assertFixtureAgency(sa);

  const db = adminDb();
  const subRef = db.doc(`subAccounts/${sa}`);
  const before = (await subRef.get()).data() ?? {};
  const originalGoogleConnectionMeta = before.googleConnectionMeta ?? null;

  const gbpItem = () =>
    page.getByTestId("launchpad-item").filter({ has: page.getByText("Connect Google Business Profile") });
  const progress = () => page.getByTestId("launchpad-progress");

  try {
    // --- disconnected: gbp item is not done ------------------------------
    await subRef.update({ googleConnectionMeta: null });
    await page.goto(`/sa/${sa}/launchpad`);
    await expect(gbpItem()).toHaveAttribute("data-done", "false", { timeout: 30_000 });
    const doneBefore = Number(await progress().getAttribute("data-done"));

    // --- connected: gbp item flips done, progress count moves by exactly
    // one (nothing else in this run touches another item) ----------------
    await subRef.update({
      googleConnectionMeta: {
        connected: true,
        email: "e2e-fixture@example.com",
        scopes: ["https://www.googleapis.com/auth/business.manage"],
        connectedAt: FieldValue.serverTimestamp(),
        connectedByUid: "e2e-fixture",
      },
    });
    await page.reload();
    await expect(gbpItem()).toHaveAttribute("data-done", "true", { timeout: 30_000 });
    await expect(progress()).toHaveAttribute("data-done", String(doneBefore + 1));

    // --- contacts: use the fixture's real count rather than assuming zero.
    // Deleting real contacts to force a false->true flip would leave a
    // teardown race with whatever else is running against this fixture, so
    // we only create when the fixture is genuinely empty and otherwise just
    // assert the done state the real count implies. ----------------------
    const existingContacts = await db
      .collection("contacts")
      .where("subAccountId", "==", sa)
      .count()
      .get();
    const contactsItem = () =>
      page.getByTestId("launchpad-item").filter({ has: page.getByText("Import contacts") });

    if (existingContacts.data().count > 0) {
      test.info().annotations.push({
        type: "note",
        description: `fixture already has ${existingContacts.data().count} contact(s); asserting done=true and skipping the false->true flip`,
      });
      await expect(contactsItem()).toHaveAttribute("data-done", "true");
    } else {
      const owner = (await db.doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()?.ownerUid as string;
      const contactRef = await db.collection("contacts").add({
        name: "E2E Launchpad Contact",
        email: "",
        phone: "",
        company: "",
        address: "",
        source: "e2e-fixture",
        tags: ["e2e-launchpad"],
        pipelineStage: null,
        attribution: null,
        emailOptedOut: false,
        smsOptedOut: false,
        territoryId: "global",
        agencyId: env.E2E_AGENCY_ID,
        subAccountId: sa,
        createdByUid: owner,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      try {
        await page.reload();
        await expect(contactsItem()).toHaveAttribute("data-done", "true", { timeout: 30_000 });
      } finally {
        await deleteScoped(contactRef);
      }
    }
  } finally {
    await subRef.update({
      googleConnectionMeta: originalGoogleConnectionMeta ?? FieldValue.delete(),
    });
  }
});
