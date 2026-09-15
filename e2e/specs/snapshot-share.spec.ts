import { createHash, randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { adminAuth, adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";

/**
 * Traces record request bodies, and this spec types a throwaway user's
 * password into the login form. Same opt-out as login.spec.ts.
 */
test.use({ trace: "off", screenshot: "off" });

/**
 * Snapshot share links, end to end across two agencies: the E2E owner shares
 * a seeded snapshot, a throwaway second agency's owner imports it through the
 * link, a single-use link refuses its second import, and a revoked link
 * refuses its first. Firestore is checked at each step so a UI that only
 * re-renders locally fails.
 *
 * Nothing here touches the fixture sub-accounts. The seeded snapshot lives
 * under E2E_AGENCY_ID; the importer is an agency this spec creates (refusing
 * an id that already exists) and deletes only while its own user owns it.
 */

const THROWAWAY_PREFIX = "e2e-import-";
const SNAPSHOT_PREFIX = "e2e-share-";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function seedSnapshot(stamp: number): Promise<string> {
  const env = readEnv();
  const db = adminDb();
  const owner = (await db.doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()
    ?.ownerUid as string;
  const id = `${SNAPSHOT_PREFIX}${stamp}`;
  await db.doc(`agencies/${env.E2E_AGENCY_ID}/snapshots/${id}`).set({
    id,
    agencyId: env.E2E_AGENCY_ID,
    name: `E2E Share ${stamp}`,
    description: "",
    version: 1,
    sourceSubAccountId: env.E2E_SUBACCOUNT_ID,
    createdByUid: owner,
    createdAt: FieldValue.serverTimestamp(),
    payload: {
      forms: [],
      messageTemplates: [{ sourceId: "t1", name: `E2E Template ${stamp}`, channel: "sms", body: "Hi" }],
      products: [],
      workflows: [],
      customFields: [],
      aiProfile: null,
    },
  });
  return id;
}

/** Delete the seeded snapshot, its shares and their index entries. */
async function deleteSeededSnapshot(id: string): Promise<void> {
  const env = readEnv();
  const db = adminDb();
  const ref = db.doc(`agencies/${env.E2E_AGENCY_ID}/snapshots/${id}`);
  if (!id.startsWith(SNAPSHOT_PREFIX)) throw new Error(`Refusing to delete snapshot ${id}`);
  const shares = await ref.collection("shares").get();
  for (const s of shares.docs) {
    await db.doc(`snapshotShareIndex/${s.data().tokenHash}`).delete();
  }
  await db.recursiveDelete(ref);
}

interface Importer {
  uid: string;
  agencyId: string;
  page: Page;
}

/**
 * A second agency with its own signed-in owner, in a fresh browser context.
 * Claims and docs mirror what /api/auth/signup writes for an agency owner.
 * Everything it creates is removed in `finally`, however `fn` ends.
 */
async function withImporter(
  browser: Browser,
  stamp: number,
  fn: (importer: Importer) => Promise<void>,
): Promise<void> {
  const db = adminDb();
  const auth = adminAuth();
  const agencyId = `${THROWAWAY_PREFIX}${stamp}`;
  const email = `${agencyId}@e2e.leadstack.invalid`;
  const password = randomBytes(24).toString("base64url");
  // Never write over (and later delete) an agency this call did not create.
  if ((await db.doc(`agencies/${agencyId}`).get()).exists) {
    throw new Error(`Agency ${agencyId} already exists; refusing to reuse it.`);
  }
  const user = await auth.createUser({ email, password, displayName: "E2E Importer" });
  const uid = user.uid;
  let context: BrowserContext | null = null;

  try {
    context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await auth.setCustomUserClaims(uid, {
      role: "admin",
      status: "active",
      agencyId,
      agencyRole: "owner",
    });
    const now = FieldValue.serverTimestamp();
    await db.doc(`users/${uid}`).set({
      uid, email, displayName: "E2E Importer", photoURL: null, stripeCustomerId: null,
      subscriptionStatus: "inactive", subscriptionPriceId: null, role: "admin",
      status: "active", primaryAgencyId: agencyId, createdAt: now, updatedAt: now,
    });
    await db.doc(`agencies/${agencyId}`).set({
      id: agencyId, name: `E2E Importer ${stamp}`, ownerUid: uid, stripeCustomerId: null,
      subscriptionStatus: "inactive", subscriptionPriceId: null, logoUrl: null,
      createdAt: now, updatedAt: now,
    });
    await db.doc(`agencies/${agencyId}/agencyMembers/${uid}`).set({
      uid, agencyId, role: "owner", status: "active", email,
      displayName: "E2E Importer", addedAt: now, addedByUid: uid,
    });
    await db.doc(`userMemberships/${uid}/agencies/${agencyId}`).set({
      agencyId, role: "owner", name: `E2E Importer ${stamp}`,
    });

    const page = await context.newPage();
    await page.goto("/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });

    await fn({ uid, agencyId, page });
  } finally {
    await context?.close();
    // Fence: only the agency this call created, still owned by its user.
    const agencyRef = db.doc(`agencies/${agencyId}`);
    const agency = (await agencyRef.get()).data();
    if (agency && agency.ownerUid !== uid) {
      throw new Error(`Refusing to delete agency ${agencyId}: not this spec's throwaway.`);
    }
    await db.recursiveDelete(agencyRef);
    await db.recursiveDelete(db.doc(`userMemberships/${uid}`));
    await db.doc(`users/${uid}`).delete();
    await auth.deleteUser(uid);
  }
}

/** As the E2E owner: open Share on the seeded snapshot and return the link. */
async function createShareLink(page: Page, snapshotId: string, singleUse: boolean): Promise<string> {
  await page.goto("/agency/sub-accounts");
  const row = page.locator(`[data-snapshot-id="${snapshotId}"]`);
  await row.getByTestId("snapshot-share-button").click({ timeout: 30_000 });
  if (singleUse) await page.getByLabel("Single use").check();
  await page.getByRole("button", { name: "Create link" }).click();
  const urlBox = page.getByTestId("snapshot-share-url");
  await expect(urlBox).toBeVisible({ timeout: 15_000 });
  const url = await urlBox.inputValue();
  await page.getByRole("button", { name: "Done" }).click();
  return url;
}

test("a single-use share link imports once into another agency, then refuses", async ({ page, browser }) => {
  const env = readEnv();
  const db = adminDb();
  const stamp = Date.now();
  const snapshotId = await seedSnapshot(stamp);

  try {
    const url = await createShareLink(page, snapshotId, true);
    const token = new URL(url).searchParams.get("token") ?? "";
    expect(token.length, "share URL carries no token").toBeGreaterThan(20);

    // The share and its index exist, and only the hash of the token is stored.
    const shares = await db.collection(`agencies/${env.E2E_AGENCY_ID}/snapshots/${snapshotId}/shares`).get();
    expect(shares.size).toBe(1);
    const share = shares.docs[0].data();
    expect(share).toMatchObject({ tokenHash: sha256(token), singleUse: true, usedCount: 0 });
    const index = await db.doc(`snapshotShareIndex/${sha256(token)}`).get();
    expect(index.data()).toMatchObject({ agencyId: env.E2E_AGENCY_ID, snapshotId, shareId: shares.docs[0].id });
    expect(JSON.stringify(share)).not.toContain(token);
    expect(JSON.stringify(index.data())).not.toContain(token);

    await withImporter(browser, stamp, async ({ agencyId, page: importerPage }) => {
      await importerPage.goto(url);
      await importerPage.getByTestId("snapshot-import-button").click({ timeout: 30_000 });
      await expect(importerPage.getByText("Imported.", { exact: false })).toBeVisible({ timeout: 15_000 });

      const imported = await db.collection(`agencies/${agencyId}/snapshots`).get();
      expect(imported.size, "import wrote no snapshot to the importer agency").toBe(1);
      const doc = imported.docs[0].data();
      expect(doc).toMatchObject({
        agencyId,
        sourceSubAccountId: null,
        importedFrom: { agencyId: env.E2E_AGENCY_ID, snapshotId, shareId: shares.docs[0].id },
      });

      await importerPage.goto("/agency/sub-accounts");
      await importerPage.getByTestId("snapshot-tab-imported").click({ timeout: 30_000 });
      await expect(
        importerPage.locator(`[data-testid="snapshot-imported-row"][data-snapshot-id="${imported.docs[0].id}"]`),
      ).toBeVisible();

      // Second import of the single-use link is refused, and writes nothing.
      await importerPage.goto(url);
      await importerPage.getByTestId("snapshot-import-button").click({ timeout: 30_000 });
      // Not getByRole("alert"): Next's route announcer is an alert too.
      await expect(importerPage.getByText("Invalid or expired link")).toBeVisible({ timeout: 15_000 });
      expect((await db.collection(`agencies/${agencyId}/snapshots`).get()).size).toBe(1);
      expect((await shares.docs[0].ref.get()).data()?.usedCount).toBe(1);
    });
  } finally {
    await deleteSeededSnapshot(snapshotId);
  }
});

test("a revoked share link refuses import", async ({ page, browser }) => {
  const env = readEnv();
  const db = adminDb();
  const stamp = Date.now();
  const snapshotId = await seedSnapshot(stamp);

  try {
    const url = await createShareLink(page, snapshotId, false);
    const token = new URL(url).searchParams.get("token") ?? "";
    const shares = await db.collection(`agencies/${env.E2E_AGENCY_ID}/snapshots/${snapshotId}/shares`).get();
    const shareId = shares.docs[0].id;

    await page.getByTestId("snapshot-tab-shared").click();
    const row = page.locator(`[data-testid="snapshot-share-row"][data-share-id="${shareId}"]`);
    await row.getByTestId("snapshot-share-revoke").click({ timeout: 15_000 });
    await expect(row.getByText("Revoked")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => (await db.doc(`snapshotShareIndex/${sha256(token)}`).get()).exists, { timeout: 15_000 })
      .toBe(false);
    expect((await shares.docs[0].ref.get()).data()?.revokedAt).toBeTruthy();

    await withImporter(browser, stamp, async ({ agencyId, page: importerPage }) => {
      await importerPage.goto(url);
      await importerPage.getByTestId("snapshot-import-button").click({ timeout: 30_000 });
      // Not getByRole("alert"): Next's route announcer is an alert too.
      await expect(importerPage.getByText("Invalid or expired link")).toBeVisible({ timeout: 15_000 });
      expect((await db.collection(`agencies/${agencyId}/snapshots`).get()).size).toBe(0);
    });
  } finally {
    await deleteSeededSnapshot(snapshotId);
  }
});
