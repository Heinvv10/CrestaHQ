import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { FieldValue } from "firebase-admin/firestore";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";

/**
 * Snapshot share links as a portable file, end to end: the E2E owner shares a
 * seeded snapshot, a logged-OUT visitor opens the share page and downloads
 * the file, the owner imports that file back in through "Import from file",
 * a single-use link refuses its second download, and a revoked link shows
 * as invalid. Firestore and the downloaded bytes are checked at each step.
 *
 * A production deployment holds ONE agency, so the cross-agency import on the
 * same deployment is covered by unit tests only; the file is the path that
 * actually crosses deployments. Nothing here touches the fixture
 * sub-accounts — every doc lives under E2E_AGENCY_ID and is removed in
 * `finally`.
 */

const SNAPSHOT_PREFIX = "e2e-share-";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const tokenOf = (url: string) => decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");

/** Destinations the source workflow carries; none may survive the download. */
const LEAK_EMAIL = "leak@e2e-source.invalid";
const LEAK_WEBHOOK = "https://e2e-source.invalid/hook";

async function seedSnapshot(stamp: number): Promise<{ id: string; formId: string }> {
  const env = readEnv();
  const db = adminDb();
  const owner = (await db.doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()?.ownerUid as string;
  const id = `${SNAPSHOT_PREFIX}${stamp}`;
  const formId = `e2e-src-form-${stamp}`;
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
      forms: [{ sourceId: formId, name: `E2E Form ${stamp}`, slug: `e2e-${stamp}`, enabled: true, fields: [],
        settings: { redirectUrl: "https://e2e-source.invalid/thanks", autoTags: [] } }],
      messageTemplates: [{ sourceId: "t1", type: "sms", name: `E2E Template ${stamp}`, body: "Hi" }],
      products: [],
      customFields: [],
      workflows: [{
        sourceId: "w1", name: `E2E Flow ${stamp}`, status: "draft", startNodeId: "n1",
        trigger: { type: "form.submitted", filters: { all: [] }, formId },
        nodes: {
          n1: { id: "n1", type: "notify", config: { recipient: "custom", to: LEAK_EMAIL, subject: "s", body: "b" }, next: "n2" },
          n2: { id: "n2", type: "webhook", config: { url: LEAK_WEBHOOK } },
        },
      }],
      aiProfile: null,
    },
  });
  return { id, formId };
}

/** Delete the seeded snapshot, its shares, their index entries and any file import of it. */
async function cleanup(id: string, importedName: string): Promise<void> {
  const env = readEnv();
  const db = adminDb();
  if (!id.startsWith(SNAPSHOT_PREFIX)) throw new Error(`Refusing to delete snapshot ${id}`);
  const ref = db.doc(`agencies/${env.E2E_AGENCY_ID}/snapshots/${id}`);
  const shares = await ref.collection("shares").get();
  for (const s of shares.docs) await db.doc(`snapshotShareIndex/${s.data().tokenHash}`).delete();
  await db.recursiveDelete(ref);
  const imported = await db
    .collection(`agencies/${env.E2E_AGENCY_ID}/snapshots`)
    .where("name", "==", importedName)
    .get();
  for (const d of imported.docs) {
    if (!d.data().importedFrom) throw new Error(`Refusing to delete non-imported snapshot ${d.id}`);
    await d.ref.delete();
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

/** A visitor with no session: opens the share page and returns it. */
async function anonymousPage(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

test("a single-use link downloads a clean portable file once, which the owner can import", async ({ page, browser }) => {
  const env = readEnv();
  const db = adminDb();
  const stamp = Date.now();
  const { id: snapshotId, formId } = await seedSnapshot(stamp);
  const name = `E2E Share ${stamp}`;

  try {
    const url = await createShareLink(page, snapshotId, true);
    expect(new URL(url).pathname.startsWith("/s/snapshot/")).toBe(true);
    const token = tokenOf(url);

    // Share + index exist; only the hash of the token is stored.
    const shares = await db.collection(`agencies/${env.E2E_AGENCY_ID}/snapshots/${snapshotId}/shares`).get();
    expect(shares.size).toBe(1);
    const share = shares.docs[0].data();
    expect(share).toMatchObject({ tokenHash: sha256(token), singleUse: true, usedCount: 0 });
    expect((await db.doc(`snapshotShareIndex/${sha256(token)}`).get()).data()).toMatchObject({ snapshotId });
    expect(JSON.stringify(share)).not.toContain(token);

    // --- (a) logged-out visitor: sees the name, downloads the file --------
    const visitor = await anonymousPage(browser, url);
    await expect(visitor.getByTestId("snapshot-share-name")).toHaveText(name, { timeout: 30_000 });
    await expect(visitor.getByTestId("snapshot-share-import-link")).toHaveCount(0);
    const [download] = await Promise.all([
      visitor.waitForEvent("download"),
      visitor.getByTestId("snapshot-download-button").click(),
    ]);
    const filePath = await download.path();
    const text = await readFile(filePath, "utf8");
    const file = JSON.parse(text) as { format: string; version: number; payload: { forms: Array<{ sourceId: string }>; workflows: Array<{ trigger: { formId: string } }> } };
    expect(file).toMatchObject({ format: "leadstack-snapshot", version: 1, name });
    for (const leak of [formId, env.E2E_SUBACCOUNT_ID, env.E2E_AGENCY_ID, LEAK_EMAIL, LEAK_WEBHOOK, "e2e-source.invalid/thanks"]) {
      expect(text, `downloaded file carries ${leak}`).not.toContain(leak);
    }
    expect(file.payload.workflows[0].trigger.formId).toBe(file.payload.forms[0].sourceId);
    await expect
      .poll(async () => (await shares.docs[0].ref.get()).data()?.usedCount, { timeout: 15_000 })
      .toBe(1);

    // --- (c) single use: second download is refused ---------------------
    const second = await visitor.request.get(`/api/public/snapshots/${encodeURIComponent(token)}`);
    expect(second.status()).toBe(404);
    await visitor.context().close();

    // --- (b) owner imports the file; Imported tab shows it ---------------
    await page.goto("/agency/sub-accounts");
    await page.getByTestId("snapshot-import-file-input").setInputFiles({
      name: "snapshot.json",
      mimeType: "application/json",
      buffer: Buffer.from(text),
    });
    const findImported = async () => {
      const q = await db
        .collection(`agencies/${env.E2E_AGENCY_ID}/snapshots`)
        .where("name", "==", name)
        .get();
      return q.docs.find((d) => d.data().importedFrom) ?? null;
    };
    await expect.poll(async () => (await findImported())?.id ?? null, { timeout: 30_000 }).not.toBeNull();
    const imported = (await findImported())!;
    expect(imported.data()).toMatchObject({
      agencyId: env.E2E_AGENCY_ID,
      sourceSubAccountId: null,
      importedFrom: { via: "file" },
    });
    expect(JSON.stringify(imported.data())).not.toContain(LEAK_EMAIL);
    await page.getByTestId("snapshot-tab-imported").click();
    await expect(
      page.locator(`[data-testid="snapshot-imported-row"][data-snapshot-id="${imported.id}"]`),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanup(snapshotId, name);
  }
});

test("a revoked link shows as invalid and refuses download", async ({ page, browser }) => {
  const env = readEnv();
  const db = adminDb();
  const stamp = Date.now();
  const { id: snapshotId } = await seedSnapshot(stamp);

  try {
    const url = await createShareLink(page, snapshotId, false);
    const token = tokenOf(url);
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

    // --- (d) the share page and the download both refuse ----------------
    const visitor = await anonymousPage(browser, url);
    await expect(visitor.getByTestId("snapshot-link-invalid")).toBeVisible({ timeout: 30_000 });
    expect((await visitor.request.get(`/api/public/snapshots/${encodeURIComponent(token)}`)).status()).toBe(404);
    await visitor.context().close();
  } finally {
    await cleanup(snapshotId, `E2E Share ${stamp}`);
  }
});
