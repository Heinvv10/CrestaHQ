import { randomBytes, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { expect, test, type Page } from "@playwright/test";
import { adminAuth, adminBucket, adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { deleteScoped, fixtureSubAccountIds } from "../lib/guard";
import { ONE_PX_PNG } from "../lib/wa";

/**
 * SP13(a) — the per-sub-account Media Library. Test 1 drives the page as the
 * fixture owner (folder → upload → rename → move → open folder → delete),
 * checking Firestore and the bucket at each step so a UI that only re-renders
 * locally fails. Test 2 proves storage.rules fence objects by sub-account: a
 * member of SECONDARY reads SECONDARY's object and is refused PRIMARY's, and
 * may upload only once their membership role is admin.
 */

/** Bucket delete, fenced to the two fixture sub-accounts' media prefixes. */
async function deleteFixtureObject(path: string): Promise<void> {
  const allowed = fixtureSubAccountIds().map((sa) => `media/${sa}/`);
  if (!allowed.some((prefix) => path.startsWith(prefix))) {
    throw new Error(`${path}: not under a fixture media prefix. Refusing to delete it.`);
  }
  await adminBucket().file(path).delete({ ignoreNotFound: true });
}

async function openTileMenu(page: Page, name: string, item: string) {
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("owner creates a folder, uploads, renames, moves, and deletes a file", async ({ page }) => {
  const env = readEnv();
  const sa = env.E2E_SUBACCOUNT_ID;
  const db = adminDb();
  const stamp = Date.now();
  const folderName = `E2E Folder ${stamp}`;
  const fileName = `e2e-media-${stamp}.png`;
  const renamed = `E2E Renamed ${stamp}`;
  const media = db.collection(`subAccounts/${sa}/media`);
  const mediaFolders = db.collection(`subAccounts/${sa}/mediaFolders`);
  const byName = async (name: string) => (await media.where("name", "==", name).get()).docs[0];

  try {
    await page.goto(`/sa/${sa}/media`);
    await expect(page.getByTestId("media-breadcrumb")).toBeVisible({ timeout: 30_000 });

    // --- folder ---------------------------------------------------------
    await page.getByTestId("media-new-folder").click();
    await page.getByLabel("Folder name").fill(folderName);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const folderTile = page.locator(`[data-testid=media-folder-tile][data-name="${folderName}"]`);
    await expect(folderTile).toBeVisible({ timeout: 15_000 });
    const folderDocs = await mediaFolders.where("name", "==", folderName).get();
    expect(folderDocs.size, "folder was not written to Firestore").toBe(1);
    const folderId = folderDocs.docs[0].id;

    // --- upload ---------------------------------------------------------
    await page.setInputFiles("[data-testid=media-upload-input]", {
      name: fileName,
      mimeType: "image/png",
      buffer: ONE_PX_PNG,
    });
    await expect(page.locator(`[data-testid=media-tile][data-name="${fileName}"]`)).toBeVisible({
      timeout: 30_000,
    });
    const uploaded = await byName(fileName);
    expect(uploaded, "media doc was not written").toBeTruthy();
    const mediaId = uploaded.id;
    const storagePath = uploaded.data().storagePath as string;
    expect(storagePath.startsWith(`media/${sa}/${mediaId}/`)).toBe(true);
    const [existsAfterUpload] = await adminBucket().file(storagePath).exists();
    expect(existsAfterUpload, "object missing from the bucket").toBe(true);

    // --- rename ---------------------------------------------------------
    await openTileMenu(page, fileName, "Rename");
    await page.getByLabel("Name", { exact: true }).fill(renamed);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await media.doc(mediaId).get()).data()?.name, { timeout: 15_000 }).toBe(renamed);
    await expect(page.locator(`[data-testid=media-tile][data-name="${renamed}"]`)).toBeVisible();

    // --- move into the folder -------------------------------------------
    await openTileMenu(page, renamed, "Move to folder");
    await page.getByLabel("Folder", { exact: true }).selectOption({ label: folderName });
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect.poll(async () => (await media.doc(mediaId).get()).data()?.folderId, { timeout: 15_000 }).toBe(folderId);
    await expect(page.locator(`[data-testid=media-tile][data-name="${renamed}"]`)).toHaveCount(0);

    // --- open the folder: the file is there, with the BUCKET's size ------
    await folderTile.click();
    await expect(page.getByTestId("media-breadcrumb")).toContainText(folderName);
    await expect(page.locator(`[data-testid=media-tile][data-name="${renamed}"]`)).toBeVisible();
    const moved = (await media.doc(mediaId).get()).data();
    expect(moved?.size).toBe(ONE_PX_PNG.byteLength);
    expect(moved?.contentType).toBe("image/png");
    expect(moved?.kind).toBe("image");

    // --- delete: doc AND object gone ------------------------------------
    await openTileMenu(page, renamed, "Delete");
    await page.getByTestId("media-delete-confirm").click();
    await expect.poll(async () => (await media.doc(mediaId).get()).exists, { timeout: 15_000 }).toBe(false);
    const [existsAfterDelete] = await adminBucket().file(storagePath).exists();
    expect(existsAfterDelete, "object survived the delete").toBe(false);
    await expect(page.locator(`[data-testid=media-tile][data-name="${renamed}"]`)).toHaveCount(0);
  } finally {
    for (const name of [fileName, renamed]) {
      const left = await byName(name);
      if (!left) continue;
      await deleteFixtureObject(left.data().storagePath as string);
      await deleteScoped(left.ref);
    }
    for (const d of (await mediaFolders.where("name", "==", folderName).get()).docs) {
      await deleteScoped(d.ref);
    }
  }
});

test("storage.rules: a SECONDARY member reads SECONDARY's object, not PRIMARY's; only an admin uploads", async () => {
  const env = readEnv();
  const [primary, secondary] = fixtureSubAccountIds();
  const bucket = adminBucket();
  const stamp = Date.now();
  const primaryPath = `media/${primary}/${randomUUID()}/e2e-${stamp}.png`;
  const secondaryPath = `media/${secondary}/${randomUUID()}/e2e-${stamp}.png`;
  const uploadPath = `media/${secondary}/${randomUUID()}/x.png`;
  const email = `e2e-media-${stamp}@example.com`;
  const password = randomBytes(18).toString("base64url");
  let uid: string | null = null;
  const memberRef = () => adminDb().doc(`subAccounts/${secondary}/subAccountMembers/${uid}`);

  try {
    for (const path of [primaryPath, secondaryPath]) {
      await bucket.file(path).save(ONE_PX_PNG, { contentType: "image/png" });
    }

    const user = await adminAuth().createUser({ email, password, displayName: "E2E Media Member" });
    uid = user.uid;
    await adminAuth().setCustomUserClaims(uid, {
      role: "collaborator",
      status: "active",
      agencyId: env.E2E_AGENCY_ID,
      agencyRole: null,
    });
    await memberRef().set({
      uid,
      subAccountId: secondary,
      agencyId: env.E2E_AGENCY_ID,
      role: "collaborator",
      status: "active",
      email,
      displayName: "E2E Media Member",
      addedAt: FieldValue.serverTimestamp(),
      addedByUid: uid,
      createdByUid: uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Signed in AFTER the claims are set, so the ID token carries them.
    const signIn = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.NEXT_PUBLIC_FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );
    expect(signIn.status, "throwaway member could not sign in").toBe(200);
    const { idToken } = (await signIn.json()) as { idToken: string };

    const read = (path: string) =>
      fetch(
        `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`,
        { headers: { Authorization: `Firebase ${idToken}` } },
      );
    expect((await read(primaryPath)).status, "member of SECONDARY read PRIMARY's object").toBe(403);
    expect((await read(secondaryPath)).status, "member could not read their own sub-account's object").toBe(200);

    // The create rule: a collaborator may read but not upload; the same
    // request succeeds once the membership row says admin. The rules read the
    // row on each request, so no new token is needed.
    const upload = () =>
      fetch(
        `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o?name=${encodeURIComponent(uploadPath)}`,
        {
          method: "POST",
          headers: { Authorization: `Firebase ${idToken}`, "Content-Type": "image/png" },
          body: new Uint8Array(ONE_PX_PNG),
        },
      );
    expect((await upload()).status, "a collaborator uploaded to the library").toBe(403);
    expect((await bucket.file(uploadPath).exists())[0]).toBe(false);
    await memberRef().update({ role: "admin", updatedAt: FieldValue.serverTimestamp() });
    expect((await upload()).status, "an admin could not upload to the library").toBe(200);
    expect((await bucket.file(uploadPath).exists())[0]).toBe(true);
  } finally {
    for (const path of [primaryPath, secondaryPath, uploadPath]) await deleteFixtureObject(path);
    if (uid) {
      await deleteScoped(memberRef());
      // Only the account this test created — its uid came from createUser above.
      await adminAuth().deleteUser(uid);
    }
  }
});
